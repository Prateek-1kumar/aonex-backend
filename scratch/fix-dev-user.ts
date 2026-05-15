// scratch/fix-dev-user.ts
// Finds dev@example.com in DB, verifies password, and updates hash if wrong.
// Run: ~/.bun/bin/bun scratch/fix-dev-user.ts

import postgres from "postgres";

const EMAIL = "dev@example.com";
const PASSWORD = "dev@123";
const DB_URL = "postgres://aonex:aonex@localhost:5432/aonex_dev";

const sql = postgres(DB_URL);

try {
  // 1. Find all merchants
  console.log("\n── All merchants in DB ──────────────────────");
  const all = await sql`SELECT id, email, display_name, tenant_id FROM merchants`;
  console.table(all);

  // 2. Find our target user
  const rows = await sql`SELECT id, email, display_name, password_hash FROM merchants WHERE email = ${EMAIL}`;

  if (rows.length === 0) {
    console.log(`\n⚠️  ${EMAIL} not found — creating from scratch...`);

    // Create tenant first
    const [tenant] = await sql`
      INSERT INTO tenants (name) VALUES ('Dev Tenant') RETURNING id, name
    `;
    console.log("✅  Tenant created:", tenant);

    const hash = await Bun.password.hash(PASSWORD, { algorithm: "argon2id" });
    const [merchant] = await sql`
      INSERT INTO merchants (tenant_id, email, password_hash, display_name)
      VALUES (${tenant.id}, ${EMAIL}, ${hash}, 'Dev User')
      RETURNING id, email, display_name
    `;
    console.log("✅  Merchant created:", merchant);
  } else {
    const merchant = rows[0]!;
    console.log(`\n✅  Found: ${merchant.email} (id: ${merchant.id})`);
    console.log(`   Hash in DB: ${merchant.password_hash}`);

    // 3. Verify existing password
    const ok = await Bun.password.verify(PASSWORD, merchant.password_hash);
    console.log(`   Password "${PASSWORD}" verifies: ${ok}`);

    if (!ok) {
      console.log("\n🔄  Hash mismatch — regenerating and updating...");
      const newHash = await Bun.password.hash(PASSWORD, { algorithm: "argon2id" });
      console.log(`   New hash: ${newHash}`);

      await sql`UPDATE merchants SET password_hash = ${newHash} WHERE email = ${EMAIL}`;

      // Verify again
      const check = await Bun.password.verify(PASSWORD, newHash);
      console.log(`   Re-verify after update: ${check}`);
      console.log("✅  Password updated successfully!");
    } else {
      console.log("✅  Password is already correct — no update needed.");
    }
  }

  // 4. Final state
  const final = await sql`SELECT id, email, display_name, tenant_id FROM merchants WHERE email = ${EMAIL}`;
  console.log("\n── Final merchant state ─────────────────────");
  console.table(final);

  console.log("\n🚀  Ready to test:");
  console.log(`   curl -s -X POST http://localhost:8787/api/auth/login \\`);
  console.log(`     -H "Content-Type: application/json" \\`);
  console.log(`     -d '{"email":"${EMAIL}","password":"${PASSWORD}"}' | jq .`);

} finally {
  await sql.end();
}
