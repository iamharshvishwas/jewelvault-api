-- D3, D20: one settings row per key, values from the prototype's DEFAULT_SETTINGS (settingsStore.ts, businessConfig.ts, EditStockClient.tsx locations).
-- Moved out: defaultGoldRate and defaultSilverRate (now daily_rates, no sample rate is seeded), the users list (now the users table), categoryPrefixes (now categories.prefix).
-- A key that already exists is left exactly as the owner has it (ON DUPLICATE KEY ... no change).
INSERT INTO settings (setting_key, value) VALUES
('business', '{"legalName":"Jaishri Gold Palace Pvt Ltd","displayName":"Jaishri Gold Palace","location":"Main Showroom","ownerName":"Jaishri Admin","phone":"","address":"","gstin":"","tagline":"Gold, silver, barcode inventory and POS"}'),
('estimate', '{"prefix":"JV","roundOff":true,"footerNote":"This is an estimate only. GST is not charged on this document."}'),
('taxes', '{"gstEnabled":false,"gstPercent":0,"estimateTaxPercent":0}'),
('tag_template', '{"widthMm":52,"heightMm":28,"fontSize":10,"barcodeHeightMm":8,"showBusinessName":true,"showDesignNumber":true,"showCategory":true,"showMaterial":true,"showCustomerNetWeight":true,"showGrossWeight":true,"showPiroi":true,"copiesPerSku":1}'),
('numbering', '{"designPadding":5,"skuPadding":3,"barcodePrefix":"BC"}'),
('materials', '[{"name":"Gold","purities":["18K","20K","22K","24K"]},{"name":"Silver","purities":["800","925","999"]}]'),
('locations', '["Main Showroom","Jaishri Vault","Workshop","Exhibition"]'),
('custom_fields', '[{"id":"cf-hallmark","label":"Hallmark","type":"Text","appliesTo":"SKU","required":false},{"id":"cf-supplier","label":"Supplier","type":"Text","appliesTo":"Design","required":false}]'),
('data_epoch', '{"epoch":"1970-01-01 00:00:00.000000"}'),
('photos', '{"maxPerDesign":3,"maxSidePx":1000,"jpegQuality":0.72,"thumbSidePx":320,"maxBytes":2097152}')
ON DUPLICATE KEY UPDATE setting_key = settings.setting_key;
