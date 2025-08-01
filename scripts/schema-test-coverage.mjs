import { readdir, readFile } from "node:fs/promises";
import YAML from "yaml";
import { join } from "node:path";
import { argv } from "node:process";
import { validate } from "@hyperjump/json-schema/draft-2020-12";
import "@hyperjump/json-schema/draft-04";
import { BASIC } from "@hyperjump/json-schema/experimental";

/**
 * @import { EvaluationPlugin } from "@hyperjump/json-schema/experimental"
 * @import { Json } from "@hyperjump/json-pointer"
 */

import contentTypeParser from "content-type";
import { addMediaTypePlugin } from "@hyperjump/browser";
import { buildSchemaDocument } from "@hyperjump/json-schema/experimental";

addMediaTypePlugin("application/schema+yaml", {
  parse: async (response) => {
    const contentType = contentTypeParser.parse(
      response.headers.get("content-type") ?? "",
    );
    const contextDialectId =
      contentType.parameters.schema ?? contentType.parameters.profile;

    const foo = YAML.parse(await response.text());
    return buildSchemaDocument(foo, response.url, contextDialectId);
  },
  fileMatcher: (path) => path.endsWith(".yaml"),
});

/** @implements EvaluationPlugin */
class TestCoveragePlugin {
  constructor() {
    /** @type Set<string> */
    this.visitedLocations = new Set();
  }

  beforeSchema(_schemaUri, _instance, context) {
    if (this.allLocations) {
      return;
    }

    /** @type Set<string> */
    this.allLocations = [];

    for (const schemaLocation in context.ast) {
      if (schemaLocation === "metaData") {
        continue;
      }

      if (Array.isArray(context.ast[schemaLocation])) {
        for (const keyword of context.ast[schemaLocation]) {
          if (Array.isArray(keyword)) {
            this.allLocations.push(keyword[1]);
          }
        }
      }
    }
  }

  beforeKeyword([, schemaUri]) {
    this.visitedLocations.add(schemaUri);
  }
}

/** @type (testDirectory: string) => AsyncGenerator<[string,Json]> */
const tests = async function* (testDirectory) {
  for (const file of await readdir(testDirectory, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!file.isFile() || !file.name.endsWith(".yaml")) {
      continue;
    }

    const testPath = join(file.parentPath, file.name);
    const testJson = await readFile(testPath, "utf8");

    yield [testPath, YAML.parse(testJson)];
  }
};

/**
 * @typedef {{
 *   allLocations: string[];
 *   visitedLocations: Set<string>;
 * }} Coverage
 */

/** @type (schemaUri: string, testDirectory: string) => Promise<Coverage> */
const runTests = async (schemaUri, testDirectory) => {
  const testCoveragePlugin = new TestCoveragePlugin();
  const validateOpenApi = await validate(schemaUri);

  for await (const [name, test] of tests(testDirectory)) {
    const result = validateOpenApi(test, {
      outputFormat: BASIC,
      plugins: [testCoveragePlugin],
    });

    if (!result.valid) {
      console.log("Failed:", name, result.errors);
    }
  }

  return {
    allLocations: testCoveragePlugin.allLocations ?? new Set(),
    visitedLocations: testCoveragePlugin.visitedLocations
  };
};

///////////////////////////////////////////////////////////////////////////////

const { allLocations, visitedLocations } = await runTests(argv[2], argv[3]);
const notCovered = allLocations.filter(
  (location) => !visitedLocations.has(location),
);
if (notCovered.length > 0) {
  console.log("NOT Covered:", notCovered.length, "of", allLocations.length);
  const maxNotCovered = 20;
  const firstNotCovered = notCovered.slice(0, maxNotCovered);
  if (notCovered.length > maxNotCovered) firstNotCovered.push("...");
  console.log(firstNotCovered);
}

console.log(
  "Covered:",
  visitedLocations.size,
  "of",
  allLocations.length,
  "(" + Math.floor((visitedLocations.size / allLocations.length) * 100) + "%)",
);

if (visitedLocations.size != allLocations.length) {
  process.exitCode = 1;
}