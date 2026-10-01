// Fold the built site into one file for the shareable preview page.
// No backend: the artifact sandbox blocks calls out, so it runs in preview mode.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dist = "dist";
const assets = readdirSync(join(dist, "assets"));
const css = assets.find((f) => f.endsWith(".css"));
const js = assets.find((f) => f.endsWith(".js"));

const out = `<title>The Deguise Family Tree</title>
<style>
${readFileSync(join(dist, "assets", css), "utf8")}
</style>
<div id="root"></div>
<script type="module">
${readFileSync(join(dist, "assets", js), "utf8")}
</script>
`;

writeFileSync("/home/claude/artifact/deguise-tree.html", out);
console.log("artifact", (out.length / 1024).toFixed(0) + " kB");
