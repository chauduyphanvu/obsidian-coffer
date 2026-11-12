/** A count and its noun: "1 file", "3 files", "1,204 changes". */
export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
