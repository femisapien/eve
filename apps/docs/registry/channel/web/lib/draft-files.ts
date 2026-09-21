export interface DraftFile {
  readonly id: string;
  readonly file: File;
}
let database: Promise<IDBDatabase> | undefined;
function openDatabase() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    let blocked = false;
    const request = indexedDB.open("eve-web-composer-files", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("files");
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) {
        db.close();
        return;
      }
      db.onversionchange = () => {
        db.close();
        database = undefined;
      };
      resolve(db);
    };
    request.onerror = () => {
      database = undefined;
      reject(request.error);
    };
    request.onblocked = () => {
      blocked = true;
      database = undefined;
      reject(new Error("Draft attachment storage is blocked."));
    };
  }));
}
export async function readDraftFiles(key?: string): Promise<DraftFile[]> {
  if (!key) return [];
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction("files", "readonly").objectStore("files").get(key);
    request.onsuccess = () => {
      if (!Array.isArray(request.result))
        reject(new Error("Saved attachments are no longer available on this device."));
      else resolve(request.result);
    };
    request.onerror = () => reject(request.error);
  });
}
export async function writeDraftFiles(files: DraftFile[]): Promise<string | undefined> {
  if (!files.length) return undefined;
  const db = await openDatabase();
  const key = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("files", "readwrite");
    transaction.objectStore("files").put(files, key);
    transaction.oncomplete = () => resolve(key);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
