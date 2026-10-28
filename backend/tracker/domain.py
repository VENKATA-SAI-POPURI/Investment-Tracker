"""Domain vocabulary shared by the ledger, analytics and API layers."""
from __future__ import annotations

import re

# ── Asset classes ──
EQUITY = "equity"
MUTUAL_FUND = "mutual_fund"
COMMODITY = "commodity"
P2P = "p2p"
FIXED_DEPOSIT = "fixed_deposit"
CASH = "cash"

ASSET_CLASSES = (EQUITY, MUTUAL_FUND, COMMODITY, P2P, FIXED_DEPOSIT, CASH)
TRADABLE = (EQUITY, MUTUAL_FUND, COMMODITY)

# ── Transaction types ──
BUY = "BUY"            # quantity, amount = INR cost (incl. charges), amount_fc = foreign-currency cost
SELL = "SELL"          # quantity, amount = INR proceeds
DIVIDEND = "DIVIDEND"  # amount = INR received
INTEREST = "INTEREST"  # amount = INR interest paid out (e.g. FD payout)
REPAYMENT = "REPAYMENT"  # P2P: amount = cash credited (principal + interest), principal, fees = platform fee
MATURITY = "MATURITY"  # FD: amount = total received, principal = deposit returned
FX_IN = "FX_IN"        # cash wallet: amount = INR sent, amount_fc = USD received
FX_OUT = "FX_OUT"      # cash wallet: amount = INR received, amount_fc = USD withdrawn

TXN_TYPES = (BUY, SELL, DIVIDEND, INTEREST, REPAYMENT, MATURITY, FX_IN, FX_OUT)
TXN_TYPES_BY_CLASS = {
    EQUITY: (BUY, SELL, DIVIDEND),
    MUTUAL_FUND: (BUY, SELL, DIVIDEND),
    COMMODITY: (BUY, SELL),
    P2P: (BUY, REPAYMENT),
    FIXED_DEPOSIT: (BUY, INTEREST, MATURITY),
    CASH: (FX_IN, FX_OUT),
}

# ── Allocation segments (labels match the targetAllocation setting) ──
SEG_EQ_IN = "Equity (India)"
SEG_EQ_US = "Equity (USA)"
SEG_MF = "Mutual Funds"
SEG_COMMODITY = "Commodity"
SEG_P2P = "P2P"
SEG_FD = "Fixed Deposits"
SEGMENTS = (SEG_EQ_IN, SEG_EQ_US, SEG_MF, SEG_COMMODITY, SEG_P2P, SEG_FD)


def segment_of(inst: dict) -> str:
    ac = inst["asset_class"]
    if ac == EQUITY:
        return SEG_EQ_US if (inst.get("market") or "").upper() in ("USA", "US") else SEG_EQ_IN
    if ac == CASH:
        # USD broker wallet is uninvested cash inside the US broker account
        return SEG_EQ_US
    return {MUTUAL_FUND: SEG_MF, COMMODITY: SEG_COMMODITY, P2P: SEG_P2P, FIXED_DEPOSIT: SEG_FD}[ac]


# ── Tax treatment ──
TAX_EQUITY = "equity"                  # listed Indian equity & equity-oriented MFs (STT paid)
TAX_FOREIGN = "foreign_equity"         # foreign stocks, overseas FoFs
TAX_DEBT = "debt"                      # specified MFs / debt — always slab
TAX_LISTED_OTHER = "listed_other"      # gold/silver ETFs and other listed units
TAX_INCOME = "income"                  # P2P / FD — interest taxed at slab
TAX_CLASSES = (TAX_EQUITY, TAX_FOREIGN, TAX_DEBT, TAX_LISTED_OTHER, TAX_INCOME)

_FOREIGN_FUND = re.compile(r"\b(us|u\.s\.|global|international|overseas|nasdaq|world|fof)\b", re.I)


def default_tax_class(asset_class: str, market: str | None = None, category: str | None = None,
                      name: str | None = None) -> str:
    if asset_class == EQUITY:
        return TAX_FOREIGN if (market or "").upper() in ("USA", "US") else TAX_EQUITY
    if asset_class == MUTUAL_FUND:
        cat = (category or "").lower()
        if "debt" in cat or "liquid" in cat or "gilt" in cat:
            return TAX_DEBT
        if name and _FOREIGN_FUND.search(name):
            return TAX_FOREIGN
        return TAX_EQUITY
    if asset_class == COMMODITY:
        return TAX_LISTED_OTHER
    return TAX_INCOME


def currency_for(asset_class: str, market: str | None) -> str:
    if asset_class == CASH:
        return "USD"
    if asset_class == EQUITY and (market or "").upper() in ("USA", "US"):
        return "USD"
    return "INR"


# ── Indian financial year helpers ──
def fy_of(date_str: str) -> str:
    """'2026-05-14' -> 'FY2026-27'."""
    y, m = int(date_str[:4]), int(date_str[5:7])
    start = y if m >= 4 else y - 1
    return f"FY{start}-{str(start + 1)[2:]}"


def fy_bounds(fy: str) -> tuple[str, str]:
    start = int(fy[2:6])
    return f"{start}-04-01", f"{start + 1}-03-31"
