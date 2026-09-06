const major = Number(process.versions.node.split('.')[0]);
if (major !== 24) {
  console.error(`Job Hunter requires Node 24.x; current runtime is ${process.version}`);
  process.exit(1);
}
console.log(`Node runtime OK: ${process.version}`);
