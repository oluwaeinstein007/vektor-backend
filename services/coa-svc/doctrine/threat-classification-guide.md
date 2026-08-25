# Threat Classification & Prioritization Guide

## Affiliation Weighting

HOSTILE-affiliated entities are the only entities that should ever appear
as a primary target in a generated COA option. NEUTRAL and UNKNOWN entities
may appear in a COA's context factors (as risks to route around or
identification priorities) but never as the object of a direct action
recommendation. FRIENDLY entities must never appear as a target under any
circumstance — see the no-strike and friendly-deconfliction sections of
Standing SOP 3-1.

## Kinematic Indicators of Intent

A track's threat priority is not determined by classification alone.
Sustained closing velocity toward a protected asset, a heading that
intersects a no-strike zone's perimeter, or a sudden deviation from a
previously stable pattern of life are all indicators that should raise
priority independent of the entity's base classification confidence.

## Sensor Corroboration as a Confidence Multiplier

A track corroborated by multiple independent sensor domains (for example,
an AIS contact confirmed by an EW/RF emission at a consistent bearing)
should be weighted as higher-confidence than a single-sensor detection of
identical classification confidence, since corroboration directly reduces
the risk of a phantom or spoofed track driving a recommendation.

## Staleness Discount

A track's priority should decay the longer it has gone without a fresh
sensor update, since the system's position estimate for it grows less
reliable with every second of extrapolation. A stale track should never be
scored as equal priority to a freshly corroborated one, even if their last
known classification and position were identical.
