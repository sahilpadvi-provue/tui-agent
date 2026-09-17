import { slugify } from "./src/slugify.js";
let bad = 0;
const eq = (n, a, b) => { if (a !== b) { console.log(`FAIL ${n}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); bad++; } else console.log(`ok   ${n}`); };
eq("basic", slugify("Hello World"), "hello-world");
eq("punctuation", slugify("Rock & Roll!"), "rock-roll");
eq("trims", slugify("  spaced  out  "), "spaced-out");
process.exit(bad ? 1 : 0);
