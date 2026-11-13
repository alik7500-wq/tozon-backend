# Plaza pilot document templates

The contract clauses come from the existing CRM `ContractPrintView.jsx` (source hash and revision in manifest.json), apartment USD branch, without barter clauses. They are not new legal texts or a harmonized translation. Existing differences between RU and TJ remain for owner review. Frozen company/director/authority replace the source's fixed Plaza signer. No historical signer is backfilled.

The Word schedule uses the existing CRM headings and plan/credited amounts, with an explicit initial-deposit row. Actual receipt dates/receipt ledger are not available in the scoped document projection and are not invented; the document explicitly directs readers to CRM receipts. Layout appendices and vehicle acts are not included in these four templates.

The core-properties marker TOZON_PLAZA_APARTMENT_USD_V1 makes the server reject these templates for parking, commercial property, barter or non-USD deals. Uploads are registered only against test complex 3 belonging to the Plaza partner project, never global scope `*`. This is not production activation or legal approval.

Rebuild from sibling frontend checkout:

```
node scripts/extract-plaza-templates.cjs /tmp/plaza-template-html
"$CODEX_PRIMARY_RUNTIME_PYTHON" scripts/build-plaza-templates.py /tmp/plaza-template-html
PLAZA_QA_OUTPUT=/tmp/plaza-qa npx vitest run src/modules/company-projects/plaza-templates.test.js
```

The extractor uses the frontend's installed React and rolldown, and executes only the local trusted JSX excerpt. The Python builder uses python-docx/lxml. Render filled QA specimens with the documents render_docx.py helper, and inspect every page before replacing registered templates. Update hashes in manifest.json after any rebuild. The database import is a scoped, reviewed data operation, not an automatic production migration.

Test-only requisites were copied from production crm_document_settings.company; registration number 6310011648 comes from the source contract. Empty bank account remains empty. Settings history records the prior empty configuration. Company/director names in signed documents still come from the frozen signer snapshot.
