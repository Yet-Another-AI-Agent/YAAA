export interface QACoverageInput {
  linesTested: number;
  linesTotal: number;
  uncoveredLines?: number[];
  filePath?: string;
}

export interface QACoverageOutput {
  coverageRatio: number;
  coveragePercentage: string;
  passedMandate: boolean;
  uncoveredLines: number[];
  recommendation: string;
}

export class QACoverageTool {
  static readonly capability = "qa";
  static readonly method = "checkCoverage";

  async execute(input: QACoverageInput): Promise<QACoverageOutput> {
    const total = Math.max(1, input.linesTotal);
    const tested = Math.min(total, Math.max(0, input.linesTested));
    const coverageRatio = tested / total;
    const passedMandate = coverageRatio >= 0.95;
    const uncoveredLines = input.uncoveredLines ?? [];

    const percentage = `${(coverageRatio * 100).toFixed(2)}%`;
    let recommendation = "";

    if (passedMandate) {
      recommendation = `Coverage mandate satisfied (${percentage} >= 95.00%). Code quality approval granted.`;
    } else {
      recommendation = `Coverage mandate FAILED (${percentage} < 95.00%). Must write unit tests covering lines: ${
        uncoveredLines.length > 0 ? uncoveredLines.join(", ") : "uncovered branches"
      }.`;
    }

    return {
      coverageRatio,
      coveragePercentage: percentage,
      passedMandate,
      uncoveredLines,
      recommendation,
    };
  }
}
