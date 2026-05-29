use serde::{Deserialize, Serialize};
use std::io::{self, Read};

const SCALAR_F: f64 = 10_000_000.0;
const SECONDS_PER_YEAR: f64 = 31_536_000.0;
const FIXED_95PCT: i64 = 9_500_000;

#[derive(Deserialize, Debug)]
#[allow(non_snake_case)]
struct RateConfig {
    rBase: i64,
    rOne: i64,
    rTwo: i64,
    rThree: i64,
    utilOpt: i64,
    irMod: i64,
    backstopFP: i64,
}

#[derive(Deserialize, Debug)]
#[allow(non_snake_case, dead_code)]
struct InputFixture {
    name: String,
    rateConfig: RateConfig,
    totalSupply: f64,
    totalBorrow: f64,
    addSupply: f64,
    addBorrow: f64,
    priceUsd: f64,
    supplyEps: u64,
    borrowEps: u64,
    blndPrice: f64,
}

#[derive(Serialize, Debug)]
#[allow(non_snake_case)]
struct ProjectedRates {
    interestSupplyApr: f64,
    interestBorrowApr: f64,
    blndSupplyApr: f64,
    blndBorrowApr: f64,
    netSupplyApr: f64,
    netBorrowCost: f64,
}

fn compute_rates(fixture: &InputFixture) -> ProjectedRates {
    let cfg = &fixture.rateConfig;
    
    let proj_supply = fixture.totalSupply + fixture.addSupply;
    let proj_borrow = fixture.totalBorrow + fixture.addBorrow;
    
    let proj_util = if proj_supply > 0.0 {
        proj_borrow / proj_supply
    } else {
        0.0
    };
    
    let util_fp = (proj_util * SCALAR_F).round() as i64;
    
    let base_rate: i64;
    if util_fp <= cfg.utilOpt {
        base_rate = cfg.rBase + (cfg.rOne as f64 * util_fp as f64 / cfg.utilOpt as f64).ceil() as i64;
    } else if util_fp <= FIXED_95PCT {
        let slope = ((util_fp - cfg.utilOpt) as f64 * SCALAR_F / (FIXED_95PCT - cfg.utilOpt) as f64).ceil() as i64;
        base_rate = cfg.rBase + cfg.rOne + (cfg.rTwo as f64 * slope as f64 / SCALAR_F).ceil() as i64;
    } else {
        let slope = ((util_fp - FIXED_95PCT) as f64 * SCALAR_F / (SCALAR_F as i64 - FIXED_95PCT) as f64).ceil() as i64;
        base_rate = cfg.rBase + cfg.rOne + cfg.rTwo + (cfg.rThree as f64 * slope as f64 / SCALAR_F).ceil() as i64;
    }
    
    let cur_ir = (base_rate as f64 * cfg.irMod as f64 / SCALAR_F).ceil() as i64;
    let interest_borrow_apr = (cur_ir as f64 / SCALAR_F) * 100.0;
    
    let supply_capture = ((SCALAR_F as i64 - cfg.backstopFP) as f64 * util_fp as f64 / SCALAR_F).floor() as i64;
    let interest_supply_apr = (((cur_ir as f64 * supply_capture as f64 / SCALAR_F).floor() as i64) as f64 / SCALAR_F) * 100.0;
    
    let supply_blnd_yr = fixture.supplyEps as f64 * SECONDS_PER_YEAR / SCALAR_F / SCALAR_F;
    let borrow_blnd_yr = fixture.borrowEps as f64 * SECONDS_PER_YEAR / SCALAR_F / SCALAR_F;
    
    let proj_supply_usd = proj_supply * fixture.priceUsd;
    let proj_borrow_usd = proj_borrow * fixture.priceUsd;
    
    let blnd_supply_apr = if proj_supply_usd > 0.0 {
        (supply_blnd_yr * fixture.blndPrice / proj_supply_usd) * 100.0
    } else {
        0.0
    };
    
    let blnd_borrow_apr = if proj_borrow_usd > 0.0 {
        (borrow_blnd_yr * fixture.blndPrice / proj_borrow_usd) * 100.0
    } else {
        0.0
    };
    
    ProjectedRates {
        interestSupplyApr: interest_supply_apr,
        interestBorrowApr: interest_borrow_apr,
        blndSupplyApr: blnd_supply_apr,
        blndBorrowApr: blnd_borrow_apr,
        netSupplyApr: interest_supply_apr + blnd_supply_apr,
        netBorrowCost: interest_borrow_apr - blnd_borrow_apr,
    }
}

fn main() {
    let mut input = String::new();
    if let Err(e) = io::stdin().read_to_string(&mut input) {
        eprintln!("Failed to read stdin: {}", e);
        std::process::exit(1);
    }
    
    let fixtures: Vec<InputFixture> = match serde_json::from_str(&input) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("Failed to parse JSON: {}", e);
            std::process::exit(1);
        }
    };
    
    let mut results = Vec::new();
    for fix in &fixtures {
        results.push(compute_rates(fix));
    }
    
    let output = serde_json::to_string_pretty(&results).unwrap();
    println!("{}", output);
}
