import AxeBuilder from '@axe-core/playwright';
import type { Page, TestInfo } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { A11Y_DIR } from './env';

export type Finding = {
  state: string;
  rule: string;
  impact: string;
  help: string;
  helpUrl: string;
  nodes: { target: string; summary: string }[];
};

const BLOCKING = new Set(['serious', 'critical']);

/** Collects axe results for many page states; serious/critical fail the test, the rest is reported. */
export class A11yRun {
  findings: Finding[] = [];
  scanned: string[] = [];

  constructor(private label: string) {}

  async scan(page: Page, state: string): Promise<void> {
    const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
    this.scanned.push(state);
    for (const v of res.violations) {
      this.findings.push({
        state,
        rule: v.id,
        impact: v.impact ?? 'minor',
        help: v.help,
        helpUrl: v.helpUrl,
        nodes: v.nodes.slice(0, 5).map((n) => ({ target: n.target.join(' >> '), summary: (n.failureSummary ?? '').split('\n').slice(1, 3).join(' ').trim() })),
      });
    }
  }

  get blocking(): Finding[] {
    return this.findings.filter((f) => BLOCKING.has(f.impact));
  }
  get advisory(): Finding[] {
    return this.findings.filter((f) => !BLOCKING.has(f.impact));
  }

  describe(list: Finding[]): string[] {
    return list.map((f) => `[${f.impact}] ${f.rule} @ ${f.state}: ${f.help} -> ${f.nodes.map((n) => `${n.target} (${n.summary})`).join(' | ')}`);
  }

  /** Writes the JSON/markdown report and attaches it to the Playwright report. */
  async save(testInfo: TestInfo): Promise<void> {
    fs.mkdirSync(A11Y_DIR, { recursive: true });
    const base = this.label.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const json = { label: this.label, scanned: this.scanned, blocking: this.blocking, advisory: this.advisory };
    fs.writeFileSync(path.join(A11Y_DIR, `${base}.json`), JSON.stringify(json, null, 2));
    const md = [`## ${this.label}`, `Scanned ${this.scanned.length} states: ${this.scanned.join(', ')}`, '', `Serious/critical: ${this.blocking.length}`, ...this.describe(this.blocking).map((l) => `- ${l}`), '', `Moderate/minor (logged only): ${this.advisory.length}`, ...this.describe(this.advisory).map((l) => `- ${l}`), ''].join('\n');
    fs.appendFileSync(path.join(A11Y_DIR, 'report.md'), md + '\n');
    await testInfo.attach('a11y-report.json', { body: JSON.stringify(json, null, 2), contentType: 'application/json' });
    for (const a of this.advisory) testInfo.annotations.push({ type: 'a11y-advisory', description: `[${a.impact}] ${a.rule} @ ${a.state}` });
  }
}
