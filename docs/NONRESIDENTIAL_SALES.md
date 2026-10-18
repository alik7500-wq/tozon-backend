# Parking and commercial sales

`units.unit_kind` identifies APARTMENT, PARKING, and COMMERCIAL. Deal list, detail,
and available inventory responses must retain this field; zero rooms is not a
property type. The existing deal, schedule, payment, reservation, signing,
cancellation, and termination flows handle all three property types.

From the project chessboard a nonresidential card opens the shared deal wizard
with an explicit initial SIGNED or RESERVED status. A reserved or sold card opens
its existing deal drawer, including payments and printing. Existing access checks
continue to apply. Saving a base price still closes the price card on success.

Parking and commercial property have no invented base price and no residential
ladder discount. The user can enter a total price or a price per square metre;
nonresidential totals and installments retain cents. The backend rejects zero or
invalid nonresidential totals and unavailable inventory before inserting a deal.

Built-in Russian and Tajik contract and schedule printing uses the property type,
block, floor, unit number, area, contract price and existing payment data. The
parking subject excludes common driveways. Contract terms retain the existing
company contract framework; this is a software adaptation, not a legal review of
the property's registration or title. Generic uploaded apartment Word templates
are not offered for nonresidential property. The built-in Print / PDF action is
available instead.

Validation uses mocked API/UI tests and repository tests plus the existing local
Postgres amendment and termination suites. No production deals or payments are
created for verification. A legacy payment integration test refuses to run when
its environment points at production; do not bypass that guard.
