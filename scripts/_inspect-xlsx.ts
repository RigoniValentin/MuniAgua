import mongoose from 'mongoose';
import { signAccessToken } from '../src/modules/auth/auth.tokens.ts';
import { defaultPermissionsForRole, ROLES } from '../src/modules/users/users.types.ts';
import { User } from '../src/modules/users/users.model.ts';
import * as XLSX from 'xlsx';
import * as fs from 'node:fs';

async function main() {
  await mongoose.connect('mongodb://127.0.0.1:27017/MuniDB');
  const admin = await User.findOne({ email: 'admin@demo.local' });
  if (!admin) throw new Error('admin not found');
  const tok = signAccessToken({
    sub: admin._id.toString(),
    role: ROLES.ADMIN,
    permissions: defaultPermissionsForRole(ROLES.ADMIN),
  });

  const url = 'http://127.0.0.1:3000/api/reports/period.xlsx?period=THIS_MONTH';
  const res = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
  if (!res.ok) {
    console.error('HTTP', res.status, await res.text());
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const out = process.argv[2] ?? 'C:/temp/informes-this-month.xlsx';
  fs.writeFileSync(out, buf);
  console.log('Saved', buf.length, 'bytes to', out);

  const wb = XLSX.read(buf, { cellDates: true });
  console.log('--- sheet names ---');
  console.log(wb.SheetNames);
  for (const name of wb.SheetNames) {
    const s = wb.Sheets[name] as XLSX.WorkSheet;
    const ref = s['!ref'] ?? '';
    const rows = XLSX.utils.sheet_to_json<unknown[]>(s, { header: 1 });
    console.log(`--- ${name} (${rows.length} rows, ref=${ref}) ---`);
    if (rows.length > 0) {
      const preview = rows.slice(0, 4);
      for (const r of preview) {
        console.log(JSON.stringify(r));
      }
    }
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
