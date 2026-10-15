-- D5, D20: the 15 categories and prefixes of the prototype (catalogStore.ts) and its four sub-categories for each.
-- Existing names are left alone (unique key on the name), so running this again changes nothing.
INSERT INTO categories (id, name, prefix) VALUES
(UUID_v4(), 'Necklace Set', 'SET'), (UUID_v4(), 'Pendant Set', 'PSET'), (UUID_v4(), 'Ring', 'RING'), (UUID_v4(), 'Earrings', 'ER'),
(UUID_v4(), 'Bangles', 'BNG'), (UUID_v4(), 'Bracelet', 'BRC'), (UUID_v4(), 'Chain', 'CHN'), (UUID_v4(), 'Pendant', 'PEND'),
(UUID_v4(), 'Kada', 'KADA'), (UUID_v4(), 'Anklet', 'ANK'), (UUID_v4(), 'Payal', 'PAY'), (UUID_v4(), 'Mangalsutra', 'MNG'),
(UUID_v4(), 'Nose Pin', 'NP'), (UUID_v4(), 'Brooch', 'BRO'), (UUID_v4(), 'Other', 'OTH')
ON DUPLICATE KEY UPDATE categories.name = categories.name;

INSERT INTO subcategories (id, category_id, name)
SELECT UUID_v4(), c.id, s.name
FROM categories c
JOIN (SELECT 'Kundan' AS name UNION ALL SELECT 'Casting' UNION ALL SELECT 'Jadau' UNION ALL SELECT 'Handmade') s
WHERE c.name IN ('Necklace Set', 'Pendant Set', 'Ring', 'Earrings', 'Bangles', 'Bracelet', 'Chain', 'Pendant', 'Kada', 'Anklet', 'Payal', 'Mangalsutra', 'Nose Pin', 'Brooch', 'Other')
ON DUPLICATE KEY UPDATE subcategories.name = subcategories.name;
