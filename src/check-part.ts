import 'dotenv/config';
import { GraphQLClient } from './graphql/client.js';

async function main() {
  const partno = process.argv[2] || '13500-010';
  const client = new GraphQLClient(process.env.M2M_GRAPHQL_URL!);

  // Find JOs with this part as a blind spot
  const db = await import('better-sqlite3');
  const d = new db.default('./data/mrp.db');
  const rows = d.prepare(`
    SELECT DISTINCT fjobno FROM bom_line_status
    WHERE fbompart = ? AND status = 'BLIND_SPOT' AND snapshot_id = (SELECT MAX(id) FROM snapshots)
    LIMIT 3
  `).all(partno) as any[];
  d.close();

  console.log(`Part ${partno} is BLIND_SPOT on: ${rows.map((r: any) => r.fjobno).join(', ')}`);

  // Check routing for subcontract ops on those JOs
  for (const row of rows) {
    const jo = row.fjobno;
    const data = await client.query<any>(`{
      getJobOrdersWhere(options: { fjobno: "${jo}" }) {
        fjobno
        jodrtg {
          foperno
          fpro_id
          fsubcont
          fvendno
          fpono
          fpoqty
          fcstat
          fnqty_comp
          fnqty_togo
          fusubcost
        }
      }
    }`);

    const job = data.getJobOrdersWhere?.[0];
    if (!job) continue;

    const subOps = (job.jodrtg || []).filter((op: any) => op.fsubcont?.trim() === 'Y');
    console.log(`\n${jo.trim()}: ${(job.jodrtg || []).length} routing ops, ${subOps.length} subcontract`);
    for (const op of subOps) {
      console.log(`  Op ${op.foperno}: WC=${(op.fpro_id || '').trim()} Vendor=${(op.fvendno || '').trim()} PO=${(op.fpono || '').trim()} Qty=${op.fpoqty} Status=${(op.fcstat || '').trim()} SubCost=${op.fusubcost}`);
    }
  }
}

main();
