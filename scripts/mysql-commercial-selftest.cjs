/* Run: node --env-file=.env scripts/mysql-commercial-selftest.cjs
 * EXPLAIN does not execute writes. Behavioral fixtures live in one rolled-back
 * transaction; no Shopify, OpenAI, Qdrant or housekeeping jobs are invoked.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const ts = require('typescript');
const { PrismaClient, Prisma } = require('@prisma/client');
const root = path.resolve(__dirname, '..');
const files = [
  'catalog/catalog-sync-job', 'commerce/shop-registry',
  'commerce/indexed-products', 'commerce/lease-lock', 'commerce/usage',
  'commerce/entitlement', 'billing/shopify-app-pricing', 'maintenance/housekeeping',
].map(name => path.join(root, 'app/services', name + '.server.ts'));

async function validateSql(db) {
  let count = 0;
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const statements = [];
    function visit(node) {
      if (ts.isTaggedTemplateExpression(node) && /\.(?:\$queryRaw|\$executeRaw)$/.test(node.tag.getText(ast))) {
        const template = node.template;
        const parts = ts.isTemplateExpression(template)
          ? [template.head.text, ...template.templateSpans.map(span => span.literal.text)]
          : [template.text];
        const values = ts.isTemplateExpression(template)
          ? template.templateSpans.map(span => {
            const expression = span.expression.getText(ast);
            return /cutoff|Until|\bnow\b|\bstart\b|\bend\b|seenBefore/i.test(expression)
              ? new Date('2026-01-01T00:00:00Z') : 1;
          }) : [];
        assert.doesNotMatch(parts.join(' '), /ON CONFLICT|INSERT OR IGNORE|julianday|excluded\./i);
        statements.push({parts, values, line: ast.getLineAndCharacterOfPosition(node.pos).line + 1});
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
    for (const {parts, values, line} of statements) {
      try {
        await db.$queryRaw(Prisma.sql(['EXPLAIN ' + parts[0], ...parts.slice(1)], ...values));
        count++;
      } catch (error) {
        throw new Error(`${path.relative(root, file)}:${line}: ${error.message}`);
      }
    }
  }
  console.log(`PASS: MySQL EXPLAIN for ${count} SQL statements across 8 files`);
}

function loadServices(tx) {
  const cache = new Map();
  const adapter = new Proxy(tx, {
    get(target, key) {
      if (key === '$transaction') return async task =>
        typeof task === 'function' ? task(adapter) : Promise.all(task);
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  function load(file) {
    file = path.resolve(file);
    if (cache.has(file)) return cache.get(file).exports;
    if (file.endsWith('db.server.ts')) return { __esModule: true, default: adapter };
    if (file.endsWith('vector-store.server.ts')) return {
      getProductVectorForShop() { throw new Error('External vector calls forbidden in this test'); },
    };
    const module = { exports: {} };
    cache.set(file, module);
    const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    const localRequire = specifier => specifier.startsWith('.')
      ? load(path.resolve(path.dirname(file), specifier + '.ts')) : require(specifier);
    new Function('require', 'module', 'exports', output)(localRequire, module, module.exports);
    return module.exports;
  }
  return name => load(path.join(root, 'app/services', name + '.server.ts'));
}

async function smoke(db) {
  const rollback = new Error('ROLLBACK_TEST_FIXTURES');
  try {
    await db.$transaction(async tx => {
      const service = loadServices(tx);
      const registry = service('commerce/shop-registry');
      const products = service('commerce/indexed-products');
      const usage = service('commerce/usage');
      const leases = service('commerce/lease-lock');
      const entitlement = service('commerce/entitlement');
      const catalog = service('catalog/catalog-sync-job');
      const shop = `mysql-test-${randomUUID()}.myshopify.com`;
      await registry.ensureShopRecord({ shop });
      await registry.updateShopSettings({ shop, aiSearchEnabled: false, resultLimit: 20, searchLanguage: 'vi' });
      await registry.ensureShopRecord({ shop });
      assert.equal((await registry.getShopSettings(shop)).aiSearchEnabled, false);
      assert.equal((await registry.getShopSettings(shop)).searchLanguage, 'vi');
      const subscription = await registry.getSubscriptionSnapshot(shop);
      const period = await usage.ensureUsagePeriod({ shop, subscription });
      assert.equal((await usage.ensureUsagePeriod({ shop, subscription })).id, period.id);

      const search = await usage.reserveSearchUsage({ shop, periodId: period.id, searchLimit: 1, query: 'áo trẻ em' });
      assert.equal(search.allowed, true);
      assert.equal((await usage.reserveSearchUsage({ shop, periodId: period.id, searchLimit: 1, query: 'blocked' })).allowed, false);
      await usage.recordQueryEmbeddingConsumed(search.reservation);
      await usage.recordQueryEmbeddingConsumed(search.reservation);
      await usage.rollbackSearchUsage(search.reservation, new Error('fixture'));
      await usage.rollbackSearchUsage(search.reservation, new Error('fixture repeat'));
      let counters = await usage.getUsagePeriodById(period.id);
      assert.equal(counters.searchCount, 0);
      assert.equal(counters.queryEmbeddingCount, 1);
      const committed = await usage.reserveSearchUsage({ shop, periodId: period.id, searchLimit: 1, query: 'quần áo' });
      await usage.markUsageReservationEffectApplied(committed.reservation);
      await usage.commitSearchUsage(committed.reservation);
      await usage.commitSearchUsage(committed.reservation);
      assert.equal((await usage.getUsageEventTypeCounts(shop, period.id)).SEARCH, 2);

      const vector = await usage.reserveProductEmbeddingUsage({ shop, periodId: period.id, productId: '1', vectorUpdateLimit: 1, countAsVectorUpdate: true });
      assert.equal(vector.allowed, true);
      assert.equal((await usage.reserveProductEmbeddingUsage({ shop, periodId: period.id, productId: '2', vectorUpdateLimit: 1, countAsVectorUpdate: true })).allowed, false);
      await usage.recordProductEmbeddingConsumed(vector.reservation);
      await usage.commitProductEmbeddingUsage(vector.reservation);
      await usage.commitProductEmbeddingUsage(vector.reservation);
      counters = await usage.getUsagePeriodById(period.id);
      assert.equal(counters.vectorUpdateCount, 1);
      assert.equal(counters.productEmbeddingCount, 1);

      const product = { shop, productId: '1', handle: 'fixture', title: 'Áo trẻ em', documentHash: 'hash' };
      assert.equal((await products.reserveProductSlot({ ...product, productLimit: 1 })).reserved, true);
      assert.equal((await products.reserveProductSlot({ ...product, productId: '2', productLimit: 1 })).allowed, false);
      await products.upsertIndexedProduct(product);
      await products.upsertIndexedProduct({ ...product, title: 'Updated' });
      assert.equal((await products.getIndexedProductStats(shop)).indexedProducts, 1);
      assert.equal((await products.getIndexedProduct(shop, '1')).title, 'Updated');
      await products.markIndexedProductBlocked({ ...product, reason: 'VECTOR_UPDATE_LIMIT', hasVector: true });
      assert.equal((await products.getIndexedProductStats(shop)).vectorQuotaBlockedProducts, 1);
      assert.equal((await entitlement.getShopEntitlement(shop)).indexedProducts, 1);

      const resource = 'fixture-lock';
      await tx.aiSearchLeaseLock.create({ data: { shop, resource, ownerToken: 'live-owner', leaseUntil: new Date(Date.now() + 60000) } });
      await assert.rejects(leases.withDistributedLease({ shop, resource, waitTimeoutMs: 0, task: async () => assert.fail('stole live lock') }), /Timed out/);
      assert.equal((await tx.aiSearchLeaseLock.findUnique({ where: { shop_resource: { shop, resource } } })).ownerToken, 'live-owner');
      await tx.aiSearchLeaseLock.update({ where: { shop_resource: { shop, resource } }, data: { leaseUntil: new Date(0) } });
      assert.equal(await leases.withDistributedLease({ shop, resource, task: async () => 'acquired' }), 'acquired');
      assert.equal(await tx.aiSearchLeaseLock.count({ where: { shop } }), 0);

      const job = await tx.aiSearchCatalogSyncJob.create({ data: { shop, reason: 'TEST', status: 'PROCESSING', attempts: 1 } });
      assert.equal(await catalog.heartbeatCatalogSyncJob(job.id, 1), true);
      assert.equal(await catalog.heartbeatCatalogSyncJob(job.id, 2), false);
      assert.equal(await catalog.markCatalogSyncDone(job.id, 1, { pagesProcessed: 1, productsProcessed: 1, productsIndexed: 1, productsSkipped: 0, productsBlocked: 0, productsFailed: 0 }), true);
      assert.equal((await catalog.getCatalogSyncJob(job.id)).status, 'DONE');
      console.log('PASS: bootstrap, quota/idempotency, product slots/upsert, lease takeover, catalog attempt fencing');
      throw rollback;
    }, { timeout: 60000 });
  } catch (error) {
    if (error !== rollback) throw error;
    console.log('PASS: all behavioral test data rolled back');
  }
}

async function main() {
  const db = new PrismaClient();
  try {
    await validateSql(db);
    await smoke(db);
  } finally { await db.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
