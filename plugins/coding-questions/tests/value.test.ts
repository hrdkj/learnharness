import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { it } from "node:test";
import { compareValue, DONT_KNOW, parseNumber, readValueResult, readReferenceOutput, referenceProgram, valueProblemDefinition } from "../src/value.ts";

it("reads numbers the way people paste them from a notebook", () => {
  assert.equal(parseNumber("0.386"), 0.386);
  assert.equal(parseNumber(" 4,000 "), 4000);
  assert.equal(parseNumber("np.float64(52.0)"), 52);
  assert.equal(parseNumber("np.int64(2)"), 2);
  assert.equal(parseNumber("'42'"), 42);
  assert.equal(parseNumber("1e-3"), 0.001);
  assert.equal(parseNumber("abc"), null);
});

it("checks numbers within tolerance and text/options loosely", () => {
  const number = { answerType: "number" as const };
  assert.equal(compareValue(number, 24.355, "24.36").status, "correct");
  assert.equal(compareValue(number, 24.355, "24.4").status, "incorrect");
  assert.equal(compareValue(number, 4000, "4000.0").status, "correct");
  assert.equal(compareValue(number, 4000, "4001").status, "incorrect");
  assert.equal(compareValue({ ...number, tolerance: 0.5 }, 3953, "3953.4").status, "correct");
  assert.equal(compareValue(number, 1, "one").status, "invalid");
  const choice = { answerType: "choice" as const, options: ["Age", "BMI"] };
  assert.equal(compareValue(choice, "BMI", " bmi ").status, "correct");
  assert.equal(compareValue({ answerType: "text" }, "GlucoseLevel", "'glucoselevel'").status, "correct");
});

it("grades I don't know as its own status, for every answer type", () => {
  for (const payload of [{ answerType: "number" as const }, { answerType: "text" as const }, { answerType: "choice" as const, options: ["a", "b"] }]) {
    const result = compareValue(payload, payload.answerType === "number" ? 42 : "a", ` ${DONT_KNOW} `);
    assert.equal(result.status, "dont_know");
    assert.equal(readValueResult(result)?.status, "dont_know");
  }
  assert.equal(compareValue({ answerType: "text" }, "a", "I don't") .status, "incorrect");
});

it("validates the pose: a key or a reference, options for choice", () => {
  const validate = (payload: unknown) => valueProblemDefinition.validateProblem({ chatId: "c", contractVersion: 1, input: { statement: "q", payload } } as never);
  assert.ok(validate({ answerType: "number" }));
  assert.equal(validate({ answerType: "number", answer: 3 }), undefined);
  assert.equal(validate({ answerType: "number", reference: "answer = 1" }), undefined);
  assert.ok(validate({ answerType: "choice", answer: "x", options: ["a", "b"] }));
  assert.equal(validate({ answerType: "choice", answer: "b", options: ["a", "b"] }), undefined);
});

const python = "/home/hrdk/avidya/.venv/bin/python";
const csv = "/home/hrdk/avidya/courses/mlp/oppe-1/mock/NPPE1_Preprocessing1.csv";
it("computes the answer from setup + reference with the real Python", { skip: !fs.existsSync(python) || !fs.existsSync(csv) }, () => {
  const run = (setup: string, reference: string) => {
    const child = spawnSync(python, ["-"], { input: referenceProgram(setup, reference), encoding: "utf8" });
    return readReferenceOutput(child.stdout);
  };
  assert.deepEqual(run(`import pandas as pd\ndf = pd.read_csv(${JSON.stringify(csv)})`, "answer = df.shape[0]"), { answer: 4000 });
  assert.deepEqual(run("import numpy as np", "answer = np.float64(0.5)"), { answer: 0.5 });
  assert.deepEqual(run("", "x = 1"), { error: "reference must assign the variable `answer`." });
  assert.ok("error" in run("", "answer = float('nan')"));
});
