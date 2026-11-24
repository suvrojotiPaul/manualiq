// Dump translators (a SQL Server case is at the end): the PostgreSQL and MySQL dumps of the synthetic support DB must load into SQLite with the
// same rows as the SQLite original; plus small cases for the scanner and type mapping.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeFixtures, FIXTURE_DIR } from './make_fixtures.mjs';
import { loadDump, detectDialect, splitStatements, planDump, mapType, copyField } from '../server/sql/dump.js';

const OUT = path.join(FIXTURE_DIR, 'dump', 'out');
let files;
before(() => { files = makeFixtures(path.join(FIXTURE_DIR, 'dump')).files; fs.mkdirSync(OUT, { recursive: true }); });

const COLS = {
  customers: ['customer_id', 'name', 'region', 'contact_email', 'created_at'],
  sites: ['site_id', 'customer_id', 'site_name', 'city', 'state', 'barn_count'],
  devices: ['device_id', 'site_id', 'model', 'part_number', 'serial_no', 'firmware', 'installed_on', 'under_warranty'],
  service_tickets: ['ticket_id', 'device_id', 'opened_at', 'closed_at', 'status', 'priority', 'alarm_type', 'symptom', 'resolution', 'technician', 'hours_spent'],
};
function snapshot(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const out = {};
  for (const [t, cols] of Object.entries(COLS)) out[t] = db.prepare(`SELECT ${cols.join(',')} FROM ${t} ORDER BY 1`).all().map(r => ({ ...r }));
  db.close();
  return out;
}

test('dialect detection', () => {
  assert.equal(detectDialect(fs.readFileSync(files.pg, 'utf8')), 'postgres');
  assert.equal(detectDialect(fs.readFileSync(files.mysql, 'utf8')), 'mysql');
  assert.equal(detectDialect('PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\nCREATE TABLE t(a);\nCOMMIT;'), 'sqlite');
});

for (const kind of ['pg', 'mysql']) {
  test(`${kind} dump loads with the same data as the SQLite original`, () => {
    const out = path.join(OUT, `${kind}.sqlite`);
    const r = loadDump(fs.readFileSync(files[kind], 'utf8'), out);
    assert.deepEqual(r.tables.map(t => t.name).sort(), ['customers', 'devices', 'service_tickets', 'sites']);
    const failed = r.skipped.filter(s => s.reason.startsWith('failed'));
    assert.deepEqual(failed, [], 'no statement should fail');
    assert.deepEqual(snapshot(out), snapshot(files.sqlite));
  });
}

test('pg: keys folded into CREATE TABLE, view and index created, extras skipped with reasons', () => {
  const out = path.join(OUT, 'pg2.sqlite');
  const r = loadDump(fs.readFileSync(files.pg, 'utf8'), out);
  const db = new DatabaseSync(out, { readOnly: true });
  const pk = db.prepare("SELECT name FROM pragma_table_info('service_tickets') WHERE pk = 1").all().map(x => x.name);
  assert.deepEqual(pk, ['ticket_id']);
  const fks = db.prepare("SELECT \"table\" AS t, \"from\" AS f FROM pragma_foreign_key_list('devices')").all().map(x => `${x.f}->${x.t}`);
  assert.deepEqual(fks, ['site_id->sites']);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='view' AND name='open_tickets'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='tickets_device'").get());
  assert.equal(typeof db.prepare('SELECT under_warranty FROM devices LIMIT 1').get().under_warranty, 'number'); // t/f -> 1/0
  db.close();
  const reasons = r.skipped.map(s => s.reason).join('\n');
  for (const want of ['session setting', 'psql meta-command', 'sequence', 'ownership', 'permissions', 'comment', 'routine/trigger not supported|object type not supported'])
    assert.match(reasons, new RegExp(want), `expected a skip reason matching ${want}`);
});

test('mysql: escapes, unsigned/AUTO_INCREMENT/ENGINE dropped, KEY -> index, FULLTEXT noted, trigger skipped', () => {
  const out = path.join(OUT, 'my2.sqlite');
  const r = loadDump(fs.readFileSync(files.mysql, 'utf8'), out);
  const db = new DatabaseSync(out, { readOnly: true });
  assert.equal(db.prepare('SELECT name FROM customers WHERE customer_id = 2').get().name, "O'Brien Poultry");
  assert.match(db.prepare('SELECT symptom FROM service_tickets WHERE ticket_id = 1007').get().symptom, /probe 1\tand probe 2.*\nsecond line; path C:\\barn\\probe/s);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_site'").get());
  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name='sites'").get().sql;
  assert.doesNotMatch(ddl, /AUTO_INCREMENT|ENGINE|unsigned|`/i);
  db.close();
  assert.ok(r.notes.some(n => /FULLTEXT/.test(n)));
  assert.ok(r.skipped.some(s => /TRIGGER/.test(s.sql)));
  assert.ok(r.skipped.some(s => /LOCK TABLES/.test(s.sql)));
});

test('scanner: semicolons inside strings, comments and $$ bodies do not split statements', () => {
  const pg = "CREATE FUNCTION f() RETURNS int AS $body$ BEGIN; RETURN 1; END $body$ LANGUAGE plpgsql;\n" +
    "INSERT INTO t VALUES ('a;b', 'it''s'); -- trailing; comment\n/* block; */ SELECT 1;";
  const st = splitStatements(pg, 'postgres');
  assert.equal(st.length, 3);
  const my = "INSERT INTO `t` VALUES ('a\\'b;c', \"x;y\");\nDELIMITER ;;\nCREATE TRIGGER x BEFORE INSERT ON t FOR EACH ROW BEGIN SET @a = 1; END ;;\nDELIMITER ;\nSELECT 2;";
  assert.equal(splitStatements(my, 'mysql').length, 3);
});

test('COPY block parsing: \\N, escapes, tabs', () => {
  assert.equal(copyField('\\N'), null);
  assert.equal(copyField('a\\tb\\nc\\\\d'), 'a\tb\nc\\d');
  assert.equal(copyField('\\101'), 'A');
  const plan = planDump('COPY public.t (a, b) FROM stdin;\n1\t\\N\n2\tx\\ty\n\\.\n', 'postgres');
  assert.deepEqual(plan.data[0].copy.rows, [['1', null], ['2', 'x\ty']]);
});

test('type mapping', () => {
  assert.equal(mapType('character varying(120)'), 'TEXT');
  assert.equal(mapType('int(10) unsigned'), 'INTEGER');
  assert.equal(mapType('bigserial'), 'INTEGER');
  assert.equal(mapType('tinyint(1)'), 'INTEGER');
  assert.equal(mapType('numeric(5,2)'), 'NUMERIC');
  assert.equal(mapType('double precision'), 'REAL');
  assert.equal(mapType('timestamp without time zone'), 'TEXT');
  assert.equal(mapType("enum('a','b')"), 'TEXT');
  assert.equal(mapType('bytea'), 'BLOB');
  assert.equal(mapType('text[]'), 'TEXT');
});

test('a SQLite .dump style script loads as written', () => {
  const out = path.join(OUT, 'lite.sqlite');
  const sql = "PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\nCREATE TABLE t(id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT);\n" +
    "INSERT INTO t VALUES(1,'a;b');\nINSERT INTO t VALUES(2,'c');\nDELETE FROM sqlite_sequence;\nINSERT INTO sqlite_sequence VALUES('t',2);\nCOMMIT;";
  const r = loadDump(sql, out);
  assert.equal(r.dialect, 'sqlite');
  assert.deepEqual(r.tables, [{ name: 't', rows: 2 }]);
});

test('broken statements are reported, the rest still loads', () => {
  const out = path.join(OUT, 'broken.sqlite');
  const sql = "-- MySQL dump\nCREATE TABLE `a` (`id` int NOT NULL, PRIMARY KEY (`id`)) ENGINE=InnoDB;\nINSERT INTO `a` VALUES (1),(2);\nINSERT INTO `nope` VALUES (1);\nFOO BAR;";
  const r = loadDump(sql, out);
  assert.deepEqual(r.tables, [{ name: 'a', rows: 2 }]);
  assert.ok(r.skipped.some(s => /failed: no such table/.test(s.reason)));
  assert.ok(r.skipped.some(s => /not recognised/.test(s.reason)));
});

// A SQL Server script in the style of SSMS / the classic sample databases: GO batches, no semicolons,
// N'' strings, [brackets], IDENTITY, DEFAULT (0), INSERT without INTO, mdy dates, 0x images, CONVERT and
// string + in views, the same index name on two tables, procedures.
const MSSQL = `SET NOCOUNT ON
GO
SET DATEFORMAT mdy
GO
if exists (select * from sysobjects where id = object_id('dbo.Gadgets') and sysstat & 0xf = 3)
	drop table "dbo"."Gadgets"
GO
CREATE TABLE [dbo].[Makers] (
	[MakerID] [int] IDENTITY (1, 1) NOT NULL ,
	[Name] nvarchar (40) NOT NULL ,
	[City] nvarchar (15) NULL ,
	CONSTRAINT [PK_Makers] PRIMARY KEY CLUSTERED ( [MakerID] ASC ) WITH (PAD_INDEX = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
CREATE TABLE "Gadgets" (
	"GadgetID" "int" IDENTITY (1, 1) NOT NULL ,
	"MakerID" "int" NULL ,
	"Title" nvarchar (40) NOT NULL ,
	"Price" "money" NULL CONSTRAINT "DF_Gadgets_Price" DEFAULT (0),
	"Stock" "smallint" NULL CONSTRAINT "DF_Gadgets_Stock" DEFAULT ((5)),
	"Active" "bit" NOT NULL DEFAULT (1),
	"Added" "datetime" NULL DEFAULT (getdate()),
	"Photo" "image" NULL ,
	CONSTRAINT "PK_Gadgets" PRIMARY KEY CLUSTERED ("GadgetID"),
	CONSTRAINT "CK_Price" CHECK (Price >= 0)
)
GO
 CREATE  INDEX "City" ON "dbo"."Makers"("City")
GO
 CREATE NONCLUSTERED INDEX [Title] ON [dbo].[Gadgets] ([Title] ASC) WITH (SORT_IN_TEMPDB = OFF) ON [PRIMARY]
GO
 CREATE  INDEX "Makers" ON "dbo"."Gadgets"("MakerID")
GO
 CREATE  INDEX "Title" ON "dbo"."Makers"("Name")
GO
create view "Gadget List" AS
SELECT Gadgets.Title + ' by ' + Makers.Name AS Label, CONVERT(money, Price * 2) AS Double
FROM Gadgets INNER JOIN Makers ON Makers.MakerID = Gadgets.MakerID
WHERE Gadgets.Added >= '19970101'
GO
create view "Top Gadgets" AS
SELECT TOP 2 Title FROM Gadgets ORDER BY Price DESC
GO
create procedure "Cheap Gadgets" AS
SET ROWCOUNT 10
SELECT Title FROM Gadgets WHERE Price < 5; SELECT 1
GO
set identity_insert "Makers" on
go
ALTER TABLE "Makers" NOCHECK CONSTRAINT ALL
go
INSERT "Makers"("MakerID","Name","City") VALUES(1,N'Ölwerk; ''Nord''',N'Bremen')
INSERT INTO [dbo].[Makers] ([MakerID], [Name], [City]) VALUES (2, N'Acme', NULL)
go
set identity_insert "Makers" off
GO
INSERT "Gadgets"("GadgetID","MakerID","Title","Price","Stock","Active","Added","Photo") VALUES(1,1,N'Widget',2.5,3,1,'7/4/1996',0x151C2F00020000000D000E0014002100FFFFFFFF4269746D6170)
INSERT "Gadgets"("GadgetID","MakerID","Title","Price","Stock","Active","Added","Photo") VALUES(2,2,N'Sprocket',10,7,0,'12/31/1997 13:05',NULL)
INSERT [dbo].[Gadgets] ([GadgetID], [MakerID], [Title], [Added]) VALUES (3, 2, N'Gear', CAST(N'1998-02-01T00:00:00.000' AS DateTime))
GO
ALTER TABLE [dbo].[Gadgets]  WITH CHECK ADD  CONSTRAINT [FK_Gadgets_Makers] FOREIGN KEY([MakerID])
REFERENCES [dbo].[Makers] ([MakerID])
GO
ALTER TABLE [dbo].[Gadgets] CHECK CONSTRAINT [FK_Gadgets_Makers]
GO
`;

test('SQL Server script: GO batches, N strings, IDENTITY, mdy dates, images, views, duplicate index names', () => {
  assert.equal(detectDialect(MSSQL), 'mssql');
  const out = path.join(OUT, 'mssql.sqlite');
  const r = loadDump(MSSQL, out);
  assert.equal(r.dialect, 'mssql');
  assert.deepEqual(r.tables, [{ name: 'Gadgets', rows: 3 }, { name: 'Makers', rows: 2 }]);
  const failed = r.skipped.filter(s => s.reason.startsWith('failed'));
  assert.equal(failed.length, 1, JSON.stringify(failed));
  assert.match(failed[0].sql, /TOP 2/);                          // TOP is not SQLite: reported, the rest loads
  assert.ok(r.skipped.some(s => /procedure/i.test(s.sql) && /not supported/.test(s.reason)));
  assert.ok(r.skipped.some(s => /^if exists/i.test(s.sql)));
  assert.ok(r.notes.some(n => /2 dates written as YYYY-MM-DD/.test(n)));

  const db = new DatabaseSync(out, { readOnly: true });
  const rows = db.prepare('SELECT GadgetID, Title, Price, Stock, Added, typeof(Photo) AS p FROM Gadgets ORDER BY 1').all().map(x => ({ ...x }));
  assert.deepEqual(rows, [
    { GadgetID: 1, Title: 'Widget', Price: 2.5, Stock: 3, Added: '1996-07-04', p: 'blob' },
    { GadgetID: 2, Title: 'Sprocket', Price: 10, Stock: 7, Added: '1997-12-31 13:05', p: 'null' },
    { GadgetID: 3, Title: 'Gear', Price: 0, Stock: 5, Added: '1998-02-01T00:00:00.000', p: 'null' },
  ]);
  assert.equal(db.prepare('SELECT Name FROM Makers WHERE MakerID = 1').get().Name, "Ölwerk; 'Nord'");
  const view = db.prepare('SELECT Label, Double FROM "Gadget List" ORDER BY 1').all().map(x => ({ ...x }));
  assert.deepEqual(view, [{ Label: 'Gear by Acme', Double: 0 }, { Label: 'Sprocket by Acme', Double: 20 }]);
  const idx = db.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY 1").all().map(x => x.name);
  // SQLite index names share one namespace with tables: clashes get the table name in front
  assert.deepEqual(idx, ['City', 'Gadgets_Makers', 'Makers_Title', 'Title']);
  const fk = db.prepare("SELECT \"table\" AS t FROM pragma_foreign_key_list('Gadgets')").all();
  assert.deepEqual(fk.map(x => x.t), ['Makers']);
  db.close();
});

test('a dump cannot ATTACH other files or call file functions', () => {
  const dir = path.join(FIXTURE_DIR, 'attach');
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, 'out.sqlite'), other = path.join(dir, 'other.db');
  const dump = `CREATE TABLE t (a INTEGER);\nINSERT INTO t VALUES (1);\nATTACH DATABASE '${other.replace(/'/g, "''")}' AS x;\nCREATE TABLE x.evil (b INTEGER);\nINSERT INTO t VALUES (2);\n`;
  const r = loadDump(dump, dest, { dialect: 'sqlite' });
  assert.ok(!fs.existsSync(other), 'ATTACH must not create another file');
  assert.ok(r.skipped.some(s => /ATTACH/.test(s.sql)));
  assert.deepEqual(r.tables.map(t => [t.name, t.rows]).filter(([n]) => n === 't'), [['t', 2]]);
});
