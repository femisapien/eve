import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const VERCEL_DIRECTORY_NAME = ".vercel";
const VERCEL_PROJECT_FILE_NAME = "project.json";
const VERCEL_BUILDS_FILE_NAME = "builds.json";

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function findClosestDirectoryWithFile(input: {
  readonly start: string;
  readonly directoryNames: readonly string[];
  readonly fileName: string;
}): Promise<string | undefined> {
  let current = input.start;

  while (true) {
    for (const directoryName of input.directoryNames) {
      const directory = join(current, directoryName);

      if (await fileExists(join(directory, input.fileName))) {
        return directory;
      }
    }

    const parent = dirname(current);

    if (parent === current) {
      return undefined;
    }

    current = parent;
  }
}

export async function findClosestLinkedVercelDirectory(start: string): Promise<string | undefined> {
  return findClosestDirectoryWithFile({
    start,
    directoryNames: [VERCEL_DIRECTORY_NAME],
    fileName: VERCEL_PROJECT_FILE_NAME,
  });
}

export async function findClosestVercelOutputDirectory(start: string): Promise<string | undefined> {
  return findClosestDirectoryWithFile({
    start,
    directoryNames: [join(VERCEL_DIRECTORY_NAME, "build-output"), "output"],
    fileName: VERCEL_BUILDS_FILE_NAME,
  });
}
