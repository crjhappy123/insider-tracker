DELETE FROM ai_scores WHERE accession_no IN (SELECT accession_no FROM transactions WHERE filing_date < '2026-08-27');
DELETE FROM transactions WHERE filing_date < '2026-08-27';
DELETE FROM daily_reports WHERE report_date < '2026-08-27';
