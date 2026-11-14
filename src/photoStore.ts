import { Buffer } from "buffer";
import { Directory, File, Paths } from "expo-file-system";
import { setPhotoStore } from "./photos";

// App-private storage: photos survive restarts but are removed with the app or the account.
const directory = new Directory(Paths.document, "student-photos");

function photoFile(key: string): File {
  return new File(directory, `${Buffer.from(key, "utf8").toString("hex")}.txt`);
}

setPhotoStore({
  async read(key) {
    const file = photoFile(key);
    if (!file.exists) return undefined;
    const dataUri = await file.text();
    return dataUri.startsWith("data:image/") ? { dataUri, savedAt: file.modificationTime ?? 0 } : undefined;
  },
  async write(key, dataUri) {
    if (!directory.exists) directory.create({ idempotent: true, intermediates: true });
    photoFile(key).write(dataUri);
  },
  async remove(key) {
    const file = photoFile(key);
    if (file.exists) file.delete();
  }
});
