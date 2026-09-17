import { total } from "./src/total.js";
let bad = 0;
const eq = (n, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) { console.log(`FAIL ${n}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); bad++; } else console.log(`ok   ${n}`); };
eq("sums line items", total([{ price: 2, qty: 3 }, { price: 5, qty: 1 }]), 11);
eq("empty is zero", total([]), 0);
process.exit(bad ? 1 : 0);
