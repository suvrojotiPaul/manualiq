// Generate the synthetic support database used by the tests, in three forms:
//   data/test-fixtures/support.sqlite       SQLite file
//   data/test-fixtures/support_pg.sql       PostgreSQL plain dump (pg_dump style, COPY blocks)
//   data/test-fixtures/support_mysql.sql    MySQL dump (mysqldump style)
// All data is made up (seeded random, same output every run). Nothing here is committed: data/ is git-ignored.
//
//   node test/make_fixtures.mjs [outDir]
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE_DIR = path.join(ROOT, 'data', 'test-fixtures');

// ---------------------------------------------------------------- data
function rng(seed) { // mulberry32
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function makeData() {
  const r = rng(20261122);
  const pick = a => a[Math.floor(r() * a.length)];
  const pad = n => String(n).padStart(2, '0');
  const day = (m, d) => `2026-${pad(m)}-${pad(d)}`;

  const customers = [
    [1, 'Maple Ridge Farms', 'Midwest', 'ops@mapleridge.example'],
    [2, "O'Brien Poultry", 'Midwest', 'barns@obrien.example'],
    [3, 'Sunny Acres Co-op', 'South', 'service@sunnyacres.example'],
    [4, 'Prairie Wind Turkeys', 'Plains', 'help@prairiewind.example'],
    [5, 'Blue Creek Layers', 'South', 'blue.creek@layers.example'],
    [6, 'Hilltop Broilers', 'Northeast', 'hilltop@broilers.example'],
    [7, 'Riverbend Growers', 'Plains', null],
    [8, 'Cedar Hollow Farm', 'Northeast', 'cedar@hollow.example'],
  ].map(([id, name, region, email], i) => ({ customer_id: id, name, region, contact_email: email, created_at: day(1 + (i % 6), 3 + i) }));

  const cities = [['Ames', 'IA'], ['Decatur', 'IL'], ['Tupelo', 'MS'], ['Salina', 'KS'], ['Gainesville', 'GA'], ['Lancaster', 'PA'], ['Fargo', 'ND'], ['Athens', 'GA']];
  const sites = [];
  let sid = 1;
  for (const c of customers) {
    const n = 1 + Math.floor(r() * 2);
    for (let k = 0; k < n; k++) {
      const [city, state] = cities[(c.customer_id + k) % cities.length];
      sites.push({ site_id: sid, customer_id: c.customer_id, site_name: `${c.name.split(' ')[0]} Site ${String.fromCharCode(65 + k)}`, city, state, barn_count: 2 + Math.floor(r() * 8) });
      sid++;
    }
  }

  const models = [
    { model: 'ClimaTrol 24', part: 'CT-00580' },
    { model: 'ClimaTrol 22', part: 'CT-00579' },
    { model: 'NovaLink Essential', part: '074-12024' },
    { model: 'BFT Ground Control', part: 'BLK-13896' },
    { model: 'Adult Turkey Feeder', part: 'FD-255' },
  ];
  const devices = [];
  let did = 1;
  for (const s of sites) {
    const n = 1 + Math.floor(r() * 3);
    for (let k = 0; k < n; k++) {
      const m = pick([0, 0, 0, 1, 1, 2, 2, 2, 3, 4].map(x => models[x])); // mostly climate controllers
      devices.push({ device_id: did, site_id: s.site_id, model: m.model, part_number: m.part,
        serial_no: `SN${String(100000 + Math.floor(r() * 899999))}`, firmware: m.model.startsWith('Adult') || m.model.startsWith('BFT') ? null : pick(['2.1', '2.3', '3.0']),
        installed_on: `${2022 + Math.floor(r() * 4)}-${pad(1 + Math.floor(r() * 12))}-${pad(1 + Math.floor(r() * 28))}`, under_warranty: r() < 0.5 });
      did++;
    }
  }

  const alarmsFor = {
    'ClimaTrol 24': ['High temperature alarm', 'Low temperature alarm', 'Defective probe', 'Water spill alarm', 'Defective static pressure sensor'],
    'ClimaTrol 22': ['High temperature alarm', 'Defective probe', 'Defective potentiometer', 'Water spill alarm'],
    'NovaLink Essential': ['Alarm relay not triggering', 'Defective probe', 'Static pressure out of range', 'High temperature alarm'],
    'BFT Ground Control': [null],
    'Adult Turkey Feeder': [null],
  };
  const symptomsFor = {
    'High temperature alarm': ['Alarm sounds every afternoon', 'Room temp 6F over set point, fans at max'],
    'Low temperature alarm': ['Alarm at night, heaters slow to start'],
    'Defective probe': ['Dashes shown instead of probe reading', 'Probe 2 reading jumps'],
    'Water spill alarm': ['Water spill alarm after flushing lines'],
    'Defective static pressure sensor': ['Inlets not opening, pressure reads 0'],
    'Defective potentiometer': ['Set point knob has no effect'],
    'Alarm relay not triggering': ['Dialer not called during power test'],
    'Static pressure out of range': ['Pressure alarm with doors closed'],
    null: ['Feeder cable slipping on winch', 'Pans not filling at end of line', 'Ground control lid hard to adjust', 'Motor hums but line does not run'],
  };
  const techs = ['A. Patel', 'J. Nguyen', 'M. Rossi', 'K. Okafor'];
  const tickets = [];
  for (let t = 1; t <= 60; t++) {
    const d = pick(devices);
    const alarm = pick(alarmsFor[d.model]);
    const month = 6 + Math.floor(r() * 6); // June - November 2026
    const dd = month === 11 ? 1 + Math.floor(r() * 20) : 1 + Math.floor(r() * 28);
    const opened = `${day(month, dd)} ${pad(6 + Math.floor(r() * 12))}:${pad(Math.floor(r() * 60))}:00`;
    const status = month === 11 ? pick(['open', 'in_progress', 'closed']) : r() < 0.85 ? 'closed' : 'open';
    let symptom = pick(symptomsFor[alarm]);
    if (t === 7) symptom = 'Customer wrote: "probe 1\tand probe 2 both show --"\nsecond line; path C:\\barn\\probe'; // escapes test
    const closedDay = Math.min(28, dd + 1 + Math.floor(r() * 5));
    tickets.push({
      ticket_id: 1000 + t, device_id: d.device_id, opened_at: opened,
      closed_at: status === 'closed' ? `${day(month, closedDay)} 16:00:00` : null,
      status, priority: pick(['low', 'normal', 'normal', 'high']), alarm_type: alarm, symptom,
      resolution: status === 'closed' ? pick(['Replaced probe', 'Recalibrated set point', 'Adjusted alarm limits', 'Re-tensioned cable', 'Firmware update', 'Cleaned sensor tubing']) : null,
      technician: pick(techs), hours_spent: status === 'closed' ? Math.round((0.5 + r() * 4) * 4) / 4 : null,
    });
  }
  return { customers, sites, devices, tickets };
}

// ---------------------------------------------------------------- writers
const TABLES = [
  ['customers', ['customer_id', 'name', 'region', 'contact_email', 'created_at']],
  ['sites', ['site_id', 'customer_id', 'site_name', 'city', 'state', 'barn_count']],
  ['devices', ['device_id', 'site_id', 'model', 'part_number', 'serial_no', 'firmware', 'installed_on', 'under_warranty']],
  ['service_tickets', ['ticket_id', 'device_id', 'opened_at', 'closed_at', 'status', 'priority', 'alarm_type', 'symptom', 'resolution', 'technician', 'hours_spent']],
];
const rowsOf = (data, t) => ({ customers: data.customers, sites: data.sites, devices: data.devices, service_tickets: data.tickets })[t];

function writeSqlite(data, file) {
  for (const f of [file, file + '-journal']) fs.rmSync(f, { force: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE customers (customer_id INTEGER PRIMARY KEY, name TEXT NOT NULL, region TEXT, contact_email TEXT, created_at TEXT);
    CREATE TABLE sites (site_id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(customer_id), site_name TEXT, city TEXT, state TEXT, barn_count INTEGER);
    CREATE TABLE devices (device_id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(site_id), model TEXT NOT NULL, part_number TEXT,
      serial_no TEXT UNIQUE, firmware TEXT, installed_on TEXT, under_warranty INTEGER DEFAULT 0);
    CREATE TABLE service_tickets (ticket_id INTEGER PRIMARY KEY, device_id INTEGER NOT NULL REFERENCES devices(device_id), opened_at TEXT NOT NULL,
      closed_at TEXT, status TEXT NOT NULL DEFAULT 'open', priority TEXT, alarm_type TEXT, symptom TEXT, resolution TEXT, technician TEXT, hours_spent NUMERIC);
    CREATE INDEX tickets_device ON service_tickets(device_id);
    CREATE VIEW open_tickets AS SELECT * FROM service_tickets WHERE status <> 'closed';
  `);
  db.exec('BEGIN');
  for (const [t, cols] of TABLES) {
    const ins = db.prepare(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
    for (const row of rowsOf(data, t)) ins.run(...cols.map(c => (typeof row[c] === 'boolean' ? (row[c] ? 1 : 0) : row[c])));
  }
  db.exec('COMMIT');
  db.close();
}

function pgCopyField(v) {
  if (v === null || v === undefined) return '\\N';
  if (typeof v === 'boolean') return v ? 't' : 'f';
  return String(v).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

function writePg(data, file) {
  const types = {
    customers: ['integer NOT NULL', 'character varying(120) NOT NULL', 'character varying(40)', 'text', "date DEFAULT CURRENT_DATE"],
    sites: ['integer NOT NULL', 'integer NOT NULL', 'text', 'text', 'character(2)', 'smallint DEFAULT 1'],
    devices: ['integer NOT NULL', 'integer NOT NULL', 'character varying(60) NOT NULL', 'character varying(30)', 'text', 'text', 'date', 'boolean DEFAULT false'],
    service_tickets: ['integer NOT NULL', 'integer NOT NULL', 'timestamp without time zone NOT NULL', 'timestamp without time zone',
      "public.ticket_status DEFAULT 'open'::public.ticket_status NOT NULL", 'text', 'text', 'text', 'text', 'text', 'numeric(5,2)'],
  };
  const pk = { customers: 'customer_id', sites: 'site_id', devices: 'device_id', service_tickets: 'ticket_id' };
  let out = `--
-- PostgreSQL database dump
--

\\restrict abc123

-- Dumped from database version 16.4
-- Dumped by pg_dump version 16.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET client_min_messages = warning;

CREATE TYPE public.ticket_status AS ENUM (
    'open',
    'in_progress',
    'closed'
);

ALTER TYPE public.ticket_status OWNER TO support;

CREATE FUNCTION public.touch_updated() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated := now(); -- a semicolon inside the body must not split the statement
  RETURN NEW;
END;
$$;

SET default_tablespace = '';
SET default_table_access_method = heap;

`;
  for (const [t, cols] of TABLES) {
    out += `--\n-- Name: ${t}; Type: TABLE; Schema: public; Owner: support\n--\n\n`;
    out += `CREATE TABLE public.${t} (\n${cols.map((c, i) => `    ${c === 'name' ? '"name"' : c} ${types[t][i]}`).join(',\n')}\n);\n\n`;
    out += `ALTER TABLE public.${t} OWNER TO support;\n\n`;
    out += `CREATE SEQUENCE public.${t}_${pk[t]}_seq\n    AS integer\n    START WITH 1\n    INCREMENT BY 1\n    NO MINVALUE\n    NO MAXVALUE\n    CACHE 1;\n\n`;
    out += `ALTER SEQUENCE public.${t}_${pk[t]}_seq OWNED BY public.${t}.${pk[t]};\n\n`;
  }
  for (const [t] of TABLES) out += `ALTER TABLE ONLY public.${t} ALTER COLUMN ${pk[t]} SET DEFAULT nextval('public.${t}_${pk[t]}_seq'::regclass);\n\n`;
  out += `COMMENT ON TABLE public.service_tickets IS 'Support tickets; one per visit or call';\n\n`;
  for (const [t, cols] of TABLES) {
    out += `--\n-- Data for Name: ${t}; Type: TABLE DATA; Schema: public; Owner: support\n--\n\n`;
    out += `COPY public.${t} (${cols.map(c => (c === 'name' ? '"name"' : c)).join(', ')}) FROM stdin;\n`;
    for (const row of rowsOf(data, t)) out += cols.map(c => pgCopyField(row[c])).join('\t') + '\n';
    out += '\\.\n\n';
  }
  for (const [t] of TABLES) out += `SELECT pg_catalog.setval('public.${t}_${pk[t]}_seq', ${rowsOf(data, t).length}, true);\n\n`;
  for (const [t] of TABLES) out += `ALTER TABLE ONLY public.${t}\n    ADD CONSTRAINT ${t}_pkey PRIMARY KEY (${pk[t]});\n\n`;
  out += `ALTER TABLE ONLY public.devices\n    ADD CONSTRAINT devices_serial_no_key UNIQUE (serial_no);\n\n`;
  out += `CREATE INDEX tickets_device ON public.service_tickets USING btree (device_id);\n\n`;
  out += `CREATE VIEW public.open_tickets AS\n SELECT ticket_id, device_id, opened_at, status\n   FROM public.service_tickets\n  WHERE (status <> 'closed'::public.ticket_status);\n\n`;
  out += `ALTER TABLE ONLY public.sites\n    ADD CONSTRAINT sites_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(customer_id);\n\n`;
  out += `ALTER TABLE ONLY public.devices\n    ADD CONSTRAINT devices_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(site_id) ON DELETE CASCADE;\n\n`;
  out += `ALTER TABLE ONLY public.service_tickets\n    ADD CONSTRAINT service_tickets_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(device_id);\n\n`;
  out += `CREATE TRIGGER trg_touch BEFORE UPDATE ON public.service_tickets FOR EACH ROW EXECUTE FUNCTION public.touch_updated();\n\n`;
  out += `GRANT SELECT ON TABLE public.service_tickets TO readonly;\n\n--\n-- PostgreSQL database dump complete\n--\n\n\\unrestrict abc123\n`;
  fs.writeFileSync(file, out);
}

function myVal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r')}'`;
}

function writeMysql(data, file) {
  const defs = {
    customers: ['`customer_id` int(11) NOT NULL AUTO_INCREMENT', '`name` varchar(120) COLLATE utf8mb4_unicode_ci NOT NULL', "`region` varchar(40) DEFAULT NULL COMMENT 'sales region'",
      '`contact_email` varchar(200) CHARACTER SET utf8mb4 DEFAULT NULL', '`created_at` date DEFAULT NULL', 'PRIMARY KEY (`customer_id`)'],
    sites: ['`site_id` int(10) unsigned NOT NULL AUTO_INCREMENT', '`customer_id` int(11) NOT NULL', '`site_name` varchar(100) DEFAULT NULL', '`city` varchar(60) DEFAULT NULL',
      '`state` char(2) DEFAULT NULL', '`barn_count` tinyint(4) DEFAULT 1', 'PRIMARY KEY (`site_id`)', 'KEY `fk_sites_customer` (`customer_id`)',
      'CONSTRAINT `fk_sites_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`customer_id`) ON DELETE CASCADE ON UPDATE CASCADE'],
    devices: ['`device_id` int(11) NOT NULL AUTO_INCREMENT', '`site_id` int(10) unsigned NOT NULL', '`model` varchar(60) NOT NULL', '`part_number` varchar(30) DEFAULT NULL',
      '`serial_no` varchar(40) DEFAULT NULL', '`firmware` varchar(10) DEFAULT NULL', '`installed_on` date DEFAULT NULL', '`under_warranty` tinyint(1) NOT NULL DEFAULT 0',
      'PRIMARY KEY (`device_id`)', 'UNIQUE KEY `uq_serial` (`serial_no`)', 'KEY `idx_site` (`site_id`) USING BTREE',
      'CONSTRAINT `fk_devices_site` FOREIGN KEY (`site_id`) REFERENCES `sites` (`site_id`)'],
    service_tickets: ['`ticket_id` int(11) NOT NULL AUTO_INCREMENT', '`device_id` int(11) NOT NULL', '`opened_at` datetime NOT NULL', '`closed_at` datetime DEFAULT NULL',
      "`status` enum('open','in_progress','closed') NOT NULL DEFAULT 'open'", "`priority` varchar(10) DEFAULT 'normal'", '`alarm_type` varchar(80) DEFAULT NULL',
      '`symptom` text', '`resolution` text', '`technician` varchar(60) DEFAULT NULL', '`hours_spent` decimal(5,2) DEFAULT NULL',
      '`updated` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP', 'PRIMARY KEY (`ticket_id`)', 'KEY `idx_device` (`device_id`)',
      'FULLTEXT KEY `ft_symptom` (`symptom`)', 'CONSTRAINT `fk_tickets_device` FOREIGN KEY (`device_id`) REFERENCES `devices` (`device_id`)'],
  };
  let out = `-- MySQL dump 10.13  Distrib 8.0.36, for Linux (x86_64)
--
-- Host: localhost    Database: support
-- ------------------------------------------------------
-- Server version	8.0.36

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
SET NAMES utf8mb4;

`;
  for (const [t, cols] of TABLES) {
    const rows = rowsOf(data, t);
    out += `--\n-- Table structure for table \`${t}\`\n--\n\nDROP TABLE IF EXISTS \`${t}\`;\n/*!40101 SET @saved_cs_client     = @@character_set_client */;\n/*!50503 SET character_set_client = utf8mb4 */;\n`;
    out += `CREATE TABLE \`${t}\` (\n  ${defs[t].join(',\n  ')}\n) ENGINE=InnoDB AUTO_INCREMENT=${rows.length + 1} DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='${t} table';\n`;
    out += `/*!40101 SET character_set_client = @saved_cs_client */;\n\n--\n-- Dumping data for table \`${t}\`\n--\n\nLOCK TABLES \`${t}\` WRITE;\n/*!40000 ALTER TABLE \`${t}\` DISABLE KEYS */;\n`;
    // two INSERT statements per table, multi-row each (as mysqldump does with --extended-insert)
    const half = Math.ceil(rows.length / 2);
    for (const part of [rows.slice(0, half), rows.slice(half)]) {
      if (!part.length) continue;
      out += `INSERT INTO \`${t}\` (${cols.map(c => `\`${c}\``).join(',')}) VALUES ${part.map(r => `(${cols.map(c => myVal(r[c])).join(',')})`).join(',')};\n`;
    }
    out += `/*!40000 ALTER TABLE \`${t}\` ENABLE KEYS */;\nUNLOCK TABLES;\n\n`;
  }
  out += `DELIMITER ;;\nCREATE TRIGGER \`trg_ticket\` BEFORE INSERT ON \`service_tickets\` FOR EACH ROW BEGIN\n  SET NEW.priority = IFNULL(NEW.priority, 'normal');\nEND ;;\nDELIMITER ;\n\n`;
  out += `/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;\n\n-- Dump completed on 2026-11-22 10:00:00\n`;
  fs.writeFileSync(file, out);
}

export function makeFixtures(dir = FIXTURE_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  const data = makeData();
  const files = { sqlite: path.join(dir, 'support.sqlite'), pg: path.join(dir, 'support_pg.sql'), mysql: path.join(dir, 'support_mysql.sql') };
  writeSqlite(data, files.sqlite);
  writePg(data, files.pg);
  writeMysql(data, files.mysql);
  return { data, files };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { data, files } = makeFixtures(process.argv[2] || FIXTURE_DIR);
  console.log(`customers ${data.customers.length}, sites ${data.sites.length}, devices ${data.devices.length}, tickets ${data.tickets.length}`);
  for (const f of Object.values(files)) console.log(`  ${f}  (${fs.statSync(f).size} bytes)`);
}
