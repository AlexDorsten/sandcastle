import { execFile } from "node:child_process";

export const checkDockerImageUid = (
  imageName: string,
  expectedUid: number,
  providerFactoryName: string,
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    execFile(
      "docker",
      ["image", "inspect", imageName, "--format", "{{.Config.User}}"],
      (error, stdout) => {
        if (error) {
          reject(
            new Error(
              `Image '${imageName}' not found locally. Build it first with 'sandcastle docker build-image'.`,
            ),
          );
          return;
        }
        const imageUser = (stdout ?? "").toString().trim();
        if (!imageUser) {
          resolve();
          return;
        }
        const uidPart = imageUser.split(":")[0]!;
        const imageUid = parseInt(uidPart, 10);
        if (isNaN(imageUid)) {
          resolve();
          return;
        }
        if (imageUid !== expectedUid) {
          reject(
            new Error(
              `UID mismatch: image '${imageName}' was built with UID ${imageUid}, ` +
                `but the expected UID is ${expectedUid}. ` +
                `Rebuild the image with 'sandcastle docker build-image', ` +
                `or pass containerUid: ${imageUid} to ${providerFactoryName}() to match the image.`,
            ),
          );
        } else {
          resolve();
        }
      },
    );
  });
