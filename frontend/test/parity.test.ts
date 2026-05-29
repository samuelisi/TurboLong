import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { projectRates, ReserveStats } from '../src/blend';

// Mock _blndPriceCache by defining fetchBlndPrice? No, projectRates uses the _blndPriceCache internal variable.
// Wait, projectRates uses _blndPriceCache. If we don't mock it, it will be 0.
// We can just rely on the fallback `const bp = _blndPriceCache ?? 0;` which means `blndSupplyApr` and `blndBorrowApr` will be 0 if we don't mock.
// But the rust binary expects blndPrice = 0.5. To test BLND apr parity, we should set `_blndPriceCache`.
// Since it's internal to blend.ts, we could call `fetchBlndPrice` and intercept the global fetch to return a specific price.
import { fetchBlndPrice } from '../src/blend';

const FIXTURES_PATH = path.resolve(__dirname, '../../tests/fixtures/rates.json');
const RUST_DIR = path.resolve(__dirname, '../../');

interface Fixture {
  name: string;
  rateConfig: any;
  totalSupply: number;
  totalBorrow: number;
  addSupply: number;
  addBorrow: number;
  priceUsd: number;
  supplyEps: number;
  borrowEps: number;
  blndPrice: number;
}

interface RustOutput {
  interestSupplyApr: number;
  interestBorrowApr: number;
  blndSupplyApr: number;
  blndBorrowApr: number;
  netSupplyApr: number;
  netBorrowCost: number;
}

describe('Parity tests between Rust simulate binary and TS projectRates', () => {
  let fixtures: Fixture[] = [];
  let rustResults: RustOutput[] = [];

  beforeAll(async () => {
    // 1. Read fixtures
    const data = fs.readFileSync(FIXTURES_PATH, 'utf-8');
    fixtures = JSON.parse(data);

    // 2. Run rust binary via execSync with fixtures fed to stdin
    const rustOutput = execSync('cargo run --bin rate_calc', {
      cwd: RUST_DIR,
      input: data,
      encoding: 'utf-8'
    });
    rustResults = JSON.parse(rustOutput);

    // Mock fetch to inject BLND price for the first fixture (we assume all use the same blndPrice for simplicity)
    if (fixtures.length > 0) {
      const blndPrice = fixtures[0].blndPrice;
      const originalFetch = global.fetch;
      global.fetch = async () => ({
        ok: true,
        json: async () => ({ blend: { usd: blndPrice } })
      }) as any;
      
      // Call fetchBlndPrice to populate the cache
      await fetchBlndPrice({} as any, '');
      global.fetch = originalFetch;
    }
  });

  it('should have loaded fixtures', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(20);
    expect(rustResults.length).toBe(fixtures.length);
  });

  describe('Fixtures', () => {
    // Dynamically create a test case for each fixture
    it('runs parity tests', () => {
      for (let i = 0; i < fixtures.length; i++) {
        const fix = fixtures[i];
        const rustRes = rustResults[i];

        // Construct mock ReserveStats
        const rs: any = {
          rateConfig: fix.rateConfig,
          totalSupply: fix.totalSupply,
          totalBorrow: fix.totalBorrow,
          priceUsd: fix.priceUsd,
          supplyEps: BigInt(fix.supplyEps),
          borrowEps: BigInt(fix.borrowEps),
        };

        const tsRes = projectRates(rs as ReserveStats, fix.addSupply, fix.addBorrow);

        const checkParity = (tsVal: number, rustVal: number, fieldName: string) => {
          const diff = Math.abs(tsVal - rustVal);
          if (diff > 1e-7) {
            throw new Error(
              `Divergence in ${fix.name} for ${fieldName}:\nTS:   ${tsVal}\nRust: ${rustVal}\nDiff: ${diff}`
            );
          }
        };

        checkParity(tsRes.interestSupplyApr, rustRes.interestSupplyApr, 'interestSupplyApr');
        checkParity(tsRes.interestBorrowApr, rustRes.interestBorrowApr, 'interestBorrowApr');
        checkParity(tsRes.blndSupplyApr, rustRes.blndSupplyApr, 'blndSupplyApr');
        checkParity(tsRes.blndBorrowApr, rustRes.blndBorrowApr, 'blndBorrowApr');
        checkParity(tsRes.netSupplyApr, rustRes.netSupplyApr, 'netSupplyApr');
        checkParity(tsRes.netBorrowCost, rustRes.netBorrowCost, 'netBorrowCost');
      }
    });
  });
});
