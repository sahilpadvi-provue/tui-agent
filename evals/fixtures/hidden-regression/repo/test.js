import { normalise, unique } from "./src/tags.js";
let bad = 0;
const eq = (n, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) { console.log(`FAIL ${n}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); bad++; } else console.log(`ok   ${n}`); };
eq("normalise trims and lowers", normalise([" A ", "b"]), ["a", "b"]);
eq("unique dedupes", unique(["A", "a", "B"]), ["a", "b"]);
eq("normalise drops empties", normalise([" A ", "", "b"]), ["a", "b"]);
process.exit(bad ? 1 : 0);
