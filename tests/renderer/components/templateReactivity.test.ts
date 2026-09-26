import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { compile } from "svelte/compiler";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Svelte wraps a call inside a template expression in untrack, so only the
// bindings spelled out in the expression are tracked as its dependencies.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function compileComponent(relativePath: string): string {
  const source = readFileSync(resolve(ROOT, relativePath), "utf8");
  // Keep lang="ts" on the tag so TS in the markup still parses; only the script
  // body needs the types stripped before the Svelte compiler sees it.
  const plain = source.replace(
    /(<script[^>]*lang="ts"[^>]*>)([\s\S]*?)(<\/script>)/g,
    (_match, open: string, body: string, close: string) => {
      const js = ts.transpileModule(body, {
        compilerOptions: {
          target: ts.ScriptTarget.ESNext,
          module: ts.ModuleKind.ESNext,
          // without this the transpiler drops imports the markup alone uses
          verbatimModuleSyntax: true,
        },
      }).outputText;
      return `${open}\n${js}${close}`;
    },
  );
  return compile(plain, { generate: "client", filename: relativePath, dev: false }).js.code;
}

// The generated shape is `(dep, dep, $.untrack(() => call(...)))`, so the tracked
// dependencies of a call are the identifiers in its sequence apart from the thunk.
function trackedDependenciesFor(generated: string, callee: string): string[][] {
  const sf = ts.createSourceFile("out.js", generated, ts.ScriptTarget.Latest, true);
  const found: string[][] = [];

  const containsCallTo = (node: ts.Node, name: string): boolean => {
    let hit = false;
    const walk = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) {
        hit = true;
      }
      ts.forEachChild(n, walk);
    };
    walk(node);
    return hit;
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "untrack" &&
      containsCallTo(node, callee)
    ) {
      const parent = node.parent;
      const deps: string[] = [];
      if (
        parent &&
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.CommaToken
      ) {
        const collect = (n: ts.Node): void => {
          if (n === node) return;
          if (ts.isIdentifier(n)) deps.push(n.text);
          ts.forEachChild(n, collect);
        };
        collect(parent);
      }
      found.push(deps);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

// A legacy `$:` statement compiles to `legacy_pre_effect(deps, body)`; it reruns
// only for the stores and state its deps thunk reads.
function reactiveDependenciesFor(generated: string, callee: string): string[][] {
  const sf = ts.createSourceFile("out.js", generated, ts.ScriptTarget.Latest, true);
  const found: string[][] = [];
  const identifiersIn = (node: ts.Node): string[] => {
    const names: string[] = [];
    const walk = (n: ts.Node): void => {
      if (ts.isIdentifier(n)) names.push(n.text);
      ts.forEachChild(n, walk);
    };
    walk(node);
    return names;
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "legacy_pre_effect"
    ) {
      const [deps, body] = node.arguments;
      if (deps && body && identifiersIn(body).includes(callee)) found.push(identifiersIn(deps));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe("template expressions keep their state dependency textual", () => {
  it("MarketMetricStrip tracks the metric state next to each value", () => {
    const generated = compileComponent("src/components/MarketMetricStrip.svelte");
    const sites = trackedDependenciesFor(generated, "valueLabel");

    expect(sites).toHaveLength(3);
    for (const deps of sites) {
      // without this the placeholder stays "..." when a lookup ends with no data
      expect(deps).toContain("state");
    }
  });

  it("MarketBrowseView tracks the item database and the translator", () => {
    const generated = compileComponent("src/components/market/MarketBrowseView.svelte");

    const labelSites = trackedDependenciesFor(generated, "catalogLabel");
    expect(labelSites.length).toBeGreaterThan(0);
    for (const deps of labelSites) {
      expect(deps).toContain("$itemDb");
    }

    const whisperSites = trackedDependenciesFor(generated, "buildWhisper");
    expect(whisperSites.length).toBeGreaterThan(0);
    for (const deps of whisperSites) {
      expect(deps).toContain("$translate");
    }
  });

  it("DropsList tracks the owned counts behind the relic chips", () => {
    const generated = compileComponent("src/components/DropsList.svelte");
    const sites = trackedDependenciesFor(generated, "ownedRelicQualities");

    expect(sites.length).toBeGreaterThan(0);
    for (const deps of sites) {
      // neither the row nor an open popover is rebuilt by an inventory push
      expect(deps).toContain("$relicOwnedCounts");
    }
  });

  it("an open drop list is rebuilt when a newer relic database arrives", () => {
    for (const file of [
      "src/components/ComponentPanel.svelte",
      "src/modals/ItemDetailModal.svelte",
    ]) {
      const sites = reactiveDependenciesFor(compileComponent(file), "resolveDrops");
      expect(sites.length, file).toBeGreaterThan(0);
      for (const deps of sites) expect(deps, file).toContain("$relicDb");
    }
  });
});
