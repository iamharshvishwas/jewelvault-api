-- D20, K5: the walk-in customer, with the fixed id the import and the tests can name. Nothing else is seeded in the business tables (no sample data, ever).
INSERT INTO customers (id, name, customer_type, is_walkin)
VALUES ('00000000-0000-4000-8000-000000000001', 'Walk-in Customer', 'Retail', 1)
ON DUPLICATE KEY UPDATE id = id;
