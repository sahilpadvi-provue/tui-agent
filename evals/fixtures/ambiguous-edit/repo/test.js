import { connect, poll } from "./src/client.js";
let bad = 0;
const eq = (n, a, b) => { if (a !== b) { console.log(`FAIL ${n}: ${a} != ${b}`); bad++; } else console.log(`ok   ${n}`); };
eq("connect timeout", connect("h").timeout, 5000);
eq("poll timeout unchanged", poll("h").timeout, 1000);
process.exit(bad ? 1 : 0);
