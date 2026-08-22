import { grade } from './_skypredict.mjs';
for (const c of [[109,181,214],[180,234,240],[128,128,128],[176,218,233],[236,235,233],[200,200,200],[90,171,211]])
  console.log(c.join(','),'->',grade(c).join(','));
