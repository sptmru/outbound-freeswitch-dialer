import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

describe("call outcome badge palette", () => {
  it("styles AVMD-detected completed calls as successful", () => {
    expect(styles).toMatch(
      /\.outcome-answered,\s*\.outcome-customer_hung_up,\s*\.outcome-voicemail_detected,\s*\.outcome-voicemail_dropped\s*\{\s*background: #dff7ed;\s*color: #08775b !important;\s*\}/
    );
  });
});
