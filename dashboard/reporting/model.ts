export type Verdict = "passed" | "failed" | "incomplete" | "unknown";
export type ExpectedOutcome = "capture-only" | "replication-success" | "expected-failure" | "recovery" | "suite" | "unknown";
export interface EvidenceRef { path: string; pointer: string; access: "local-only" }
export interface Fact<T> { value: T | null; evidence: EvidenceRef[] }
export interface Assertion {
  id: string; status: Verdict; description: string; evidence: EvidenceRef[];
}
export interface Measurement {
  id: string; value: number; unit: "seconds" | "events/second" | "events";
  definition: string; evidence: EvidenceRef[];
}
export interface Scenario {
  id: string; title: string; question: string; action: string; expected: string; evidence: string[];
}
export interface Run {
  presentation?: import("./presentation.ts").Presentation;
  schemaVersion: 1;
  id: string;
  artifactDirectory: string;
  phase: number | null;
  kind: "run" | "suite";
  verdict: Verdict;
  expectedOutcome: ExpectedOutcome;
  failureKind: "startup" | "execution" | "assertion" | "evidence" | null;
  failureCode: Fact<string>;
  verdictEvidence: EvidenceRef[];
  rawExitCodes: { host: Fact<number>; harness: Fact<number> };
  startedAt: Fact<string>;
  finishedAt: Fact<string>;
  code: Fact<{ commit: string | null; dirty: boolean | null }>;
  configuration: Fact<Record<string, string | number | boolean>>;
  versions: Fact<Record<string, string>>;
  images: Fact<{ repository: string; tag: string | null; id: string | null; platform: string | null }[]>;
  relationships: { parentSuiteId: Fact<string>; gateId: Fact<string>; children: Fact<string[]> };
  scenarioIds: string[];
  assertions: Assertion[];
  counts: Record<"expectedEvents" | "capturedEvents" | "appliedEvents" | "dlqDeliveries" | "uniqueQuarantines" | "expectedQuarantines", Fact<number>>;
  measurements: Measurement[];
  sequence: { label: string; timestamp: null; evidence: EvidenceRef[] }[];
  evidence: EvidenceRef[];
  issues: string[];
  limitations: string[];
}
export interface Report {
  schemaVersion: 1;
  generatedAt: string;
  catalog: Scenario[];
  runs: Run[];
  discoveryIssues: string[];
  // Deliberately no global event total: suites reference leaves; reruns repeat workloads.
  summary: { runs: number; suites: number; verdicts: Record<Verdict, number> };
}
export const fact = <T>(value: T | null = null, evidence: EvidenceRef[] = []): Fact<T> => ({ value, evidence });
