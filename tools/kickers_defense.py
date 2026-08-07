#!/usr/bin/env python3
"""
Season scoring for the two positions the projection set was missing.

The app rosters a kicker and a team defense, but data/projections-2026.json
contained only quarterbacks, backs, receivers and tight ends -- so neither
position existed in the database at all. Nothing could be drafted at either one,
and, worse, the auction engine read both as permanently unfilled starting slots,
which left its "steer toward the holes" rule switched on for the entire draft.

Neither position is in the weekly stats as a fantasy row: kickers carry
fantasy_points_ppr = 0 (the nflverse column only scores offence), and a team
defense is not a player at all. Both are reconstructed here from the underlying
counting stats using ESPN's default scoring, so the rank curve for them is
fitted on real history exactly like the other four positions rather than
assumed.

Kicker  : FG 0-39 = 3, 40-49 = 4, 50+ = 5, PAT = 1, missed FG = -1.
Defense : sack 1, interception 2, fumble recovery 2, safety 2, TD 6, plus the
          points-allowed ladder. Points allowed comes from the game scores.
"""
import csv
import os
from collections import defaultdict

from build_data import HERE, FANTASY_WEEKS

FG_BUCKETS = {
    "fg_made_0_19": 3.0, "fg_made_20_29": 3.0, "fg_made_30_39": 3.0,
    "fg_made_40_49": 4.0, "fg_made_50_59": 5.0, "fg_made_60_": 5.0,
}


def _f(row, key):
    try:
        return float(row.get(key) or 0.0)
    except (TypeError, ValueError):
        return 0.0


def points_allowed_score(pa):
    """ESPN's default points-allowed ladder."""
    if pa == 0:
        return 5.0
    if pa <= 6:
        return 4.0
    if pa <= 13:
        return 3.0
    if pa <= 17:
        return 1.0
    if pa <= 27:
        return 0.0
    if pa <= 34:
        return -1.0
    if pa <= 45:
        return -3.0
    return -5.0


def _points_allowed(year):
    """{(week, team): points the opponent scored against them}."""
    out = {}
    path = os.path.join(HERE, "games.csv")
    with open(path, newline="", encoding="utf-8") as f:
        for g in csv.DictReader(f):
            if g.get("game_type") != "REG" or str(g.get("season")) != str(year):
                continue
            try:
                wk = int(g["week"])
                home, away = float(g["home_score"]), float(g["away_score"])
            except (TypeError, ValueError, KeyError):
                continue
            out[(wk, g["home_team"])] = away
            out[(wk, g["away_team"])] = home
    return out


def kicker_totals(year):
    """{kicker name: season fantasy points} for one season."""
    tot = defaultdict(float)
    with open(os.path.join(HERE, f"wk_{year}.csv"), newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row.get("season_type") != "REG" or row.get("position") != "K":
                continue
            try:
                wk = int(row["week"])
            except (TypeError, ValueError, KeyError):
                continue
            if wk not in FANTASY_WEEKS:
                continue
            name = row.get("player_display_name") or row.get("player_name") or ""
            if not name:
                continue
            pts = _f(row, "pat_made")
            for col, val in FG_BUCKETS.items():
                pts += _f(row, col) * val
            pts -= _f(row, "fg_missed")
            tot[name] += pts
    return dict(tot)


def defense_totals(year):
    """{team: season D/ST fantasy points} for one season."""
    pa = _points_allowed(year)
    stats = defaultdict(lambda: defaultdict(float))
    seen = set()
    with open(os.path.join(HERE, f"wk_{year}.csv"), newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row.get("season_type") != "REG":
                continue
            try:
                wk = int(row["week"])
            except (TypeError, ValueError, KeyError):
                continue
            if wk not in FANTASY_WEEKS:
                continue
            team = row.get("team")
            if not team:
                continue
            k = (wk, team)
            seen.add(k)
            s = stats[k]
            s["sack"] += _f(row, "def_sacks")
            s["int"] += _f(row, "def_interceptions")
            # Only opponent fumbles the defense actually came away with count.
            s["fr"] += _f(row, "fumble_recovery_opp")
            s["saf"] += _f(row, "def_safeties")
            s["td"] += _f(row, "def_tds") + _f(row, "special_teams_tds")

    tot = defaultdict(float)
    for (wk, team) in seen:
        s = stats[(wk, team)]
        pts = (s["sack"] * 1.0 + s["int"] * 2.0 + s["fr"] * 2.0
               + s["saf"] * 2.0 + s["td"] * 6.0)
        allowed = pa.get((wk, team))
        if allowed is None:
            continue          # bye week or missing score: no game, no points
        pts += points_allowed_score(allowed)
        tot[team] += pts
    return dict(tot)


if __name__ == "__main__":
    for y in (2023, 2024, 2025):
        k = sorted(kicker_totals(y).items(), key=lambda x: -x[1])
        d = sorted(defense_totals(y).items(), key=lambda x: -x[1])
        print(f"\n{y}  ({len(k)} kickers, {len(d)} defenses)")
        print("  K1  %-22s %6.1f     K12 %-22s %6.1f"
              % (k[0][0], k[0][1], k[11][0], k[11][1]))
        print("  D1  %-22s %6.1f     D12 %-22s %6.1f"
              % (d[0][0], d[0][1], d[11][0], d[11][1]))
