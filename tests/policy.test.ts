import { describe, it, expect } from "vitest";

// Test the glob matching and policy evaluation logic directly.
// Re-implement inline to avoid importing the server module (which connects to stdio).

function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    const next = glob[i + 1];
    if (ch === "*" && next === "*") {
      out += ".*";
      i++;
    } else if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  out += "$";
  return new RegExp(out);
}

function matchesGlob(file: string, pattern: string): boolean {
  return globToRegExp(pattern).test(file);
}

type PolicyViolation = {
  type: "forbidden_file_modified" | "outside_allowed_files";
  file: string;
  pattern?: string;
};

function evaluatePolicy(params: {
  changed_files: string[];
  allowed_files?: string[];
  forbidden_files?: string[];
}) {
  const violations: PolicyViolation[] = [];

  for (const file of params.changed_files) {
    for (const pattern of params.forbidden_files ?? []) {
      if (matchesGlob(file, pattern)) {
        violations.push({ type: "forbidden_file_modified", file, pattern });
      }
    }

    if (params.allowed_files?.length) {
      const allowed = params.allowed_files.some((pattern) => matchesGlob(file, pattern));
      if (!allowed) violations.push({ type: "outside_allowed_files", file });
    }
  }

  return {
    forbidden_file_modified: violations.some((v) => v.type === "forbidden_file_modified"),
    outside_allowed_files: violations.some((v) => v.type === "outside_allowed_files"),
    violations,
  };
}

describe("globToRegExp", () => {
  it("matches exact file", () => {
    expect(matchesGlob("src/foo.ts", "src/foo.ts")).toBe(true);
  });

  it("matches wildcard in directory", () => {
    expect(matchesGlob("src/foo.ts", "src/*.ts")).toBe(true);
    expect(matchesGlob("src/bar.ts", "src/*.ts")).toBe(true);
  });

  it("rejects non-matching wildcard", () => {
    expect(matchesGlob("test/foo.ts", "src/*.ts")).toBe(false);
  });

  it("matches deep globstar", () => {
    expect(matchesGlob("a/b/c/d.ts", "a/**")).toBe(true);
    expect(matchesGlob("a/b/c/d.ts", "a/**/*.ts")).toBe(true);
  });

  it("rejects path traversal in pattern", () => {
    expect(matchesGlob("src/foo.ts", "../src/foo.ts")).toBe(false);
  });

  it("matches single-char wildcard", () => {
    expect(matchesGlob("src/a.ts", "src/?.ts")).toBe(true);
    expect(matchesGlob("src/ab.ts", "src/?.ts")).toBe(false);
  });
});

describe("evaluatePolicy", () => {
  it("passes when no constraints", () => {
    const result = evaluatePolicy({ changed_files: ["src/foo.ts"] });
    expect(result.violations).toHaveLength(0);
    expect(result.forbidden_file_modified).toBe(false);
    expect(result.outside_allowed_files).toBe(false);
  });

  it("detects forbidden file modification", () => {
    const result = evaluatePolicy({
      changed_files: [".env", "src/foo.ts"],
      forbidden_files: [".env", "secrets/**"],
    });
    expect(result.forbidden_file_modified).toBe(true);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].file).toBe(".env");
  });

  it("detects file outside allowed list", () => {
    const result = evaluatePolicy({
      changed_files: ["src/foo.ts", "src/bar.ts"],
      allowed_files: ["src/foo.ts"],
    });
    expect(result.outside_allowed_files).toBe(true);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].file).toBe("src/bar.ts");
  });

  it("multiple violations reported", () => {
    const result = evaluatePolicy({
      changed_files: [".env", "secret.key", "src/foo.ts"],
      forbidden_files: [".env", "*.key"],
      allowed_files: ["src/foo.ts"],
    });
    // .env: forbidden + outside_allowed = 2
    // secret.key: forbidden + outside_allowed = 2
    // src/foo.ts: OK = 0
    expect(result.violations).toHaveLength(4);
    expect(result.forbidden_file_modified).toBe(true);
    expect(result.outside_allowed_files).toBe(true);
  });

  it("empty changed files has no violations", () => {
    const result = evaluatePolicy({
      changed_files: [],
      forbidden_files: [".env"],
      allowed_files: ["src/**"],
    });
    expect(result.violations).toHaveLength(0);
  });

  it("globstar in forbidden files works", () => {
    const result = evaluatePolicy({
      changed_files: ["migrations/001.sql"],
      forbidden_files: ["migrations/**"],
    });
    expect(result.forbidden_file_modified).toBe(true);
  });
});
