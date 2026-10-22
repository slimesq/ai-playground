'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

// Independent snapshots of the original 156 Zero Voice sessions and three public catalogs.
// These expected values are deliberately stored here so checks need no live API or temporary export files.
const ORIGINAL_SESSIONS = [
  ["ls40-00000-00039","2026-10-05",39,[{"lessonId":"w01-周一-ls-lesson-1","startMinute":0,"endMinute":39}]],
  ["ls40-00039-00078","2026-10-06",39,[{"lessonId":"w01-周二-ls-lesson-1","startMinute":0,"endMinute":39}]],
  ["ls40-00078-00115","2026-10-07",37,[{"lessonId":"w01-周三-ls-lesson-1","startMinute":0,"endMinute":37}]],
  ["ls40-00115-00154","2026-10-08",39,[{"lessonId":"w01-周三-ls-lesson-2","startMinute":0,"endMinute":16},{"lessonId":"w01-周四-ls-lesson-1","startMinute":0,"endMinute":23}]],
  ["ls40-00154-00192","2026-10-09",38,[{"lessonId":"w01-周四-ls-lesson-1","startMinute":23,"endMinute":34},{"lessonId":"w01-周四-ls-lesson-2","startMinute":0,"endMinute":27}]],
  ["ls40-00192-00230","2026-10-12",38,[{"lessonId":"w01-周四-ls-lesson-2","startMinute":27,"endMinute":34},{"lessonId":"w01-周五-ls-lesson-1","startMinute":0,"endMinute":31}]],
  ["ls40-00230-00268","2026-10-13",38,[{"lessonId":"w01-周五-ls-lesson-1","startMinute":31,"endMinute":35},{"lessonId":"w01-周五-ls-lesson-2","startMinute":0,"endMinute":34}]],
  ["ls40-00268-00304","2026-10-14",36,[{"lessonId":"w02-周一-ls-lesson-1","startMinute":0,"endMinute":36}]],
  ["ls40-00304-00340","2026-10-15",36,[{"lessonId":"w02-周一-ls-lesson-2","startMinute":0,"endMinute":36}]],
  ["ls40-00340-00379","2026-10-16",39,[{"lessonId":"w02-周二-ls-lesson-1","startMinute":0,"endMinute":39}]],
  ["ls40-00379-00417","2026-10-19",38,[{"lessonId":"w02-周三-ls-lesson-1","startMinute":0,"endMinute":38}]],
  ["ls40-00417-00454","2026-10-20",37,[{"lessonId":"w02-周四-ls-lesson-1","startMinute":0,"endMinute":37}]],
  ["ls40-00454-00495","2026-10-21",41,[{"lessonId":"w02-周四-ls-lesson-2","startMinute":0,"endMinute":36},{"lessonId":"w02-周五-ls-lesson-1","startMinute":0,"endMinute":5}]],
  ["ls40-00495-00536","2026-10-22",41,[{"lessonId":"w02-周五-ls-lesson-1","startMinute":5,"endMinute":46}]],
  ["ls40-00536-00572","2026-10-23",36,[{"lessonId":"w03-周一-ls-lesson-1","startMinute":0,"endMinute":36}]],
  ["ls40-00572-00608","2026-10-26",36,[{"lessonId":"w03-周一-ls-lesson-2","startMinute":0,"endMinute":36}]],
  ["ls40-00608-00649","2026-10-27",41,[{"lessonId":"w03-周二-ls-lesson-1","startMinute":0,"endMinute":41}]],
  ["ls40-00649-00688","2026-10-28",39,[{"lessonId":"w03-周三-ls-lesson-1","startMinute":0,"endMinute":39}]],
  ["ls40-00688-00726","2026-10-29",38,[{"lessonId":"w03-周四-ls-lesson-1","startMinute":0,"endMinute":38}]],
  ["ls40-00726-00769","2026-10-30",43,[{"lessonId":"w03-周五-ls-lesson-1","startMinute":0,"endMinute":43}]],
  ["ls40-00769-00812","2026-11-02",43,[{"lessonId":"w03-周五-ls-lesson-1","startMinute":43,"endMinute":58},{"lessonId":"w04-周一-ls-lesson-1","startMinute":0,"endMinute":28}]],
  ["ls40-00812-00854","2026-11-03",42,[{"lessonId":"w04-周一-ls-lesson-1","startMinute":28,"endMinute":58},{"lessonId":"w04-周二-ls-lesson-1","startMinute":0,"endMinute":12}]],
  ["ls40-00854-00897","2026-11-04",43,[{"lessonId":"w04-周二-ls-lesson-2","startMinute":0,"endMinute":43}]],
  ["ls40-00897-00941","2026-11-05",44,[{"lessonId":"w04-周三-ls-lesson-1","startMinute":0,"endMinute":44}]],
  ["ls40-00941-00982","2026-11-06",41,[{"lessonId":"w04-周四-ls-lesson-1","startMinute":0,"endMinute":41}]],
  ["ls40-00982-01023","2026-11-09",41,[{"lessonId":"w04-周四-ls-lesson-1","startMinute":41,"endMinute":48},{"lessonId":"w04-周五-ls-lesson-1","startMinute":0,"endMinute":34}]],
  ["ls40-01023-01064","2026-11-10",41,[{"lessonId":"w04-周五-ls-lesson-1","startMinute":34,"endMinute":48},{"lessonId":"w05-周一-ls-lesson-1","startMinute":0,"endMinute":27}]],
  ["ls40-01064-01104","2026-11-11",40,[{"lessonId":"w05-周一-ls-lesson-1","startMinute":27,"endMinute":52},{"lessonId":"w05-周二-ls-lesson-1","startMinute":0,"endMinute":15}]],
  ["ls40-01104-01145","2026-11-12",41,[{"lessonId":"w05-周二-ls-lesson-2","startMinute":0,"endMinute":27},{"lessonId":"w05-周三-ls-lesson-1","startMinute":0,"endMinute":14}]],
  ["ls40-01145-01186","2026-11-13",41,[{"lessonId":"w05-周三-ls-lesson-1","startMinute":14,"endMinute":23},{"lessonId":"w05-周三-ls-lesson-2","startMinute":0,"endMinute":32}]],
  ["ls40-01186-01227","2026-11-16",41,[{"lessonId":"w05-周三-ls-lesson-2","startMinute":32,"endMinute":42},{"lessonId":"w05-周四-ls-lesson-1","startMinute":0,"endMinute":31}]],
  ["ls40-01227-01268","2026-11-17",41,[{"lessonId":"w05-周四-ls-lesson-1","startMinute":31,"endMinute":60},{"lessonId":"w05-周五-ls-lesson-1","startMinute":0,"endMinute":12}]],
  ["ls40-01268-01310","2026-11-18",42,[{"lessonId":"w05-周五-ls-lesson-2","startMinute":0,"endMinute":21},{"lessonId":"w06-周一-ls-lesson-1","startMinute":0,"endMinute":21}]],
  ["ls40-01310-01352","2026-11-19",42,[{"lessonId":"w06-周一-ls-lesson-1","startMinute":21,"endMinute":39},{"lessonId":"w06-周二-ls-lesson-1","startMinute":0,"endMinute":24}]],
  ["ls40-01352-01394","2026-11-20",42,[{"lessonId":"w06-周二-ls-lesson-1","startMinute":24,"endMinute":45},{"lessonId":"w06-周二-ls-lesson-2","startMinute":0,"endMinute":5},{"lessonId":"w06-周二-ls-lesson-3","startMinute":0,"endMinute":16}]],
  ["ls40-01394-01432","2026-11-23",38,[{"lessonId":"w06-周三-ls-lesson-1","startMinute":0,"endMinute":38}]],
  ["ls40-01432-01470","2026-11-24",38,[{"lessonId":"w06-周三-ls-lesson-2","startMinute":0,"endMinute":38}]],
  ["ls40-01470-01514","2026-11-25",44,[{"lessonId":"w06-周四-ls-lesson-1","startMinute":0,"endMinute":44}]],
  ["ls40-01514-01558","2026-11-26",44,[{"lessonId":"w06-周五-ls-lesson-1","startMinute":0,"endMinute":44}]],
  ["ls40-01558-01601","2026-11-27",43,[{"lessonId":"w07-周一-ls-lesson-1","startMinute":0,"endMinute":43}]],
  ["ls40-01601-01640","2026-11-30",39,[{"lessonId":"w07-周二-ls-lesson-1","startMinute":0,"endMinute":39}]],
  ["ls40-01640-01679","2026-12-01",39,[{"lessonId":"w07-周二-ls-lesson-1","startMinute":39,"endMinute":57},{"lessonId":"w07-周三-ls-lesson-1","startMinute":0,"endMinute":21}]],
  ["ls40-01679-01721","2026-12-02",42,[{"lessonId":"w07-周四-ls-lesson-1","startMinute":0,"endMinute":42}]],
  ["ls40-01721-01762","2026-12-03",41,[{"lessonId":"w07-周四-ls-lesson-1","startMinute":42,"endMinute":60},{"lessonId":"w07-周五-ls-lesson-1","startMinute":0,"endMinute":17},{"lessonId":"w07-周五-ls-lesson-2","startMinute":0,"endMinute":6}]],
  ["ls40-01762-01803","2026-12-04",41,[{"lessonId":"w07-周五-ls-lesson-2","startMinute":6,"endMinute":47}]],
  ["ls40-01803-01845","2026-12-07",42,[{"lessonId":"w08-周一-ls-lesson-1","startMinute":0,"endMinute":42}]],
  ["ls40-01845-01886","2026-12-08",41,[{"lessonId":"w08-周一-ls-lesson-1","startMinute":42,"endMinute":47},{"lessonId":"w08-周一-ls-lesson-2","startMinute":0,"endMinute":6},{"lessonId":"w08-周二-ls-lesson-1","startMinute":0,"endMinute":30}]],
  ["ls40-01886-01927","2026-12-09",41,[{"lessonId":"w08-周二-ls-lesson-1","startMinute":30,"endMinute":49},{"lessonId":"w08-周三-ls-lesson-1","startMinute":0,"endMinute":22}]],
  ["ls40-01927-01968","2026-12-10",41,[{"lessonId":"w08-周三-ls-lesson-1","startMinute":22,"endMinute":32},{"lessonId":"w08-周三-ls-lesson-2","startMinute":0,"endMinute":31}]],
  ["ls40-01968-02011","2026-12-11",43,[{"lessonId":"w08-周四-ls-lesson-1","startMinute":0,"endMinute":35},{"lessonId":"w08-周五-ls-lesson-1","startMinute":0,"endMinute":8}]],
  ["ls40-02011-02053","2026-12-14",42,[{"lessonId":"w08-周五-ls-lesson-1","startMinute":8,"endMinute":15},{"lessonId":"w08-周五-ls-lesson-2","startMinute":0,"endMinute":35}]],
  ["ls40-02053-02093","2026-12-15",40,[{"lessonId":"w09-周一-ls-lesson-1","startMinute":0,"endMinute":10},{"lessonId":"w09-周一-ls-lesson-2","startMinute":0,"endMinute":30}]],
  ["ls40-02093-02132","2026-12-16",39,[{"lessonId":"w09-周一-ls-lesson-2","startMinute":30,"endMinute":36},{"lessonId":"w09-周一-ls-lesson-3","startMinute":0,"endMinute":5},{"lessonId":"w09-周二-ls-lesson-1","startMinute":0,"endMinute":28}]],
  ["ls40-02132-02176","2026-12-17",44,[{"lessonId":"w09-周二-ls-lesson-2","startMinute":0,"endMinute":44}]],
  ["ls40-02176-02220","2026-12-18",44,[{"lessonId":"w09-周三-ls-lesson-1","startMinute":0,"endMinute":44}]],
  ["ls40-02220-02263","2026-12-21",43,[{"lessonId":"w09-周四-ls-lesson-1","startMinute":0,"endMinute":43}]],
  ["ls40-02263-02303","2026-12-22",40,[{"lessonId":"w09-周五-ls-lesson-1","startMinute":0,"endMinute":40}]],
  ["ls40-02303-02343","2026-12-23",40,[{"lessonId":"w09-周五-ls-lesson-1","startMinute":40,"endMinute":46},{"lessonId":"w10-周一-ls-lesson-1","startMinute":0,"endMinute":34}]],
  ["ls40-02343-02383","2026-12-24",40,[{"lessonId":"w10-周一-ls-lesson-1","startMinute":34,"endMinute":45},{"lessonId":"w10-周二-ls-lesson-1","startMinute":0,"endMinute":29}]],
  ["ls40-02383-02423","2026-12-25",40,[{"lessonId":"w10-周二-ls-lesson-1","startMinute":29,"endMinute":45},{"lessonId":"w10-周三-ls-lesson-1","startMinute":0,"endMinute":24}]],
  ["ls40-02423-02462","2026-12-28",39,[{"lessonId":"w10-周三-ls-lesson-1","startMinute":24,"endMinute":51},{"lessonId":"w10-周四-ls-lesson-1","startMinute":0,"endMinute":12}]],
  ["ls40-02462-02501","2026-12-29",39,[{"lessonId":"w10-周四-ls-lesson-1","startMinute":12,"endMinute":51}]],
  ["ls40-02501-02542","2026-12-30",41,[{"lessonId":"w10-周五-ls-lesson-1","startMinute":0,"endMinute":41}]],
  ["ls40-02542-02583","2026-12-31",41,[{"lessonId":"w10-周五-ls-lesson-1","startMinute":41,"endMinute":50},{"lessonId":"w10-周五-ls-lesson-2","startMinute":0,"endMinute":17},{"lessonId":"w11-周一-ls-lesson-1","startMinute":0,"endMinute":15}]],
  ["ls40-02583-02623","2027-01-01",40,[{"lessonId":"w11-周一-ls-lesson-1","startMinute":15,"endMinute":29},{"lessonId":"w11-周一-ls-lesson-2","startMinute":0,"endMinute":26}]],
  ["ls40-02623-02667","2027-01-04",44,[{"lessonId":"w11-周二-ls-lesson-1","startMinute":0,"endMinute":9},{"lessonId":"w11-周二-ls-lesson-2","startMinute":0,"endMinute":35}]],
  ["ls40-02667-02708","2027-01-05",41,[{"lessonId":"w11-周三-ls-lesson-1","startMinute":0,"endMinute":23},{"lessonId":"w11-周三-ls-lesson-2","startMinute":0,"endMinute":18}]],
  ["ls40-02708-02748","2027-01-06",40,[{"lessonId":"w11-周三-ls-lesson-2","startMinute":18,"endMinute":23},{"lessonId":"w11-周四-ls-lesson-1","startMinute":0,"endMinute":35}]],
  ["ls40-02748-02792","2027-01-07",44,[{"lessonId":"w11-周四-ls-lesson-2","startMinute":0,"endMinute":34},{"lessonId":"w11-周五-ls-lesson-1","startMinute":0,"endMinute":10}]],
  ["ls40-02792-02836","2027-01-08",44,[{"lessonId":"w11-周五-ls-lesson-1","startMinute":10,"endMinute":54}]],
  ["ls40-02836-02877","2027-01-11",41,[{"lessonId":"w12-周一-ls-lesson-1","startMinute":0,"endMinute":41}]],
  ["ls40-02877-02918","2027-01-12",41,[{"lessonId":"w12-周一-ls-lesson-1","startMinute":41,"endMinute":57},{"lessonId":"w12-周二-ls-lesson-1","startMinute":0,"endMinute":25}]],
  ["ls40-02918-02958","2027-01-13",40,[{"lessonId":"w12-周三-ls-lesson-1","startMinute":0,"endMinute":40}]],
  ["ls40-02958-02998","2027-01-14",40,[{"lessonId":"w12-周三-ls-lesson-1","startMinute":40,"endMinute":53},{"lessonId":"w12-周四-ls-lesson-1","startMinute":0,"endMinute":27}]],
  ["ls40-02998-03037","2027-01-15",39,[{"lessonId":"w12-周四-ls-lesson-1","startMinute":27,"endMinute":52},{"lessonId":"w12-周四-ls-lesson-2","startMinute":0,"endMinute":3},{"lessonId":"w12-周四-ls-lesson-3","startMinute":0,"endMinute":5},{"lessonId":"w12-周五-ls-lesson-1","startMinute":0,"endMinute":6}]],
  ["ls40-03037-03074","2027-01-18",37,[{"lessonId":"w12-周五-ls-lesson-2","startMinute":0,"endMinute":21},{"lessonId":"w12-周五-ls-lesson-3","startMinute":0,"endMinute":7},{"lessonId":"w12-周五-ls-lesson-4","startMinute":0,"endMinute":9}]],
  ["ls40-03074-03113","2027-01-19",39,[{"lessonId":"w12-周五-ls-lesson-5","startMinute":0,"endMinute":17},{"lessonId":"w13-周一-ls-lesson-1","startMinute":0,"endMinute":9},{"lessonId":"w13-周一-ls-lesson-2","startMinute":0,"endMinute":10},{"lessonId":"w13-周一-ls-lesson-3","startMinute":0,"endMinute":3}]],
  ["ls40-03113-03151","2027-01-20",38,[{"lessonId":"w13-周一-ls-lesson-4","startMinute":0,"endMinute":6},{"lessonId":"w13-周一-ls-lesson-5","startMinute":0,"endMinute":1},{"lessonId":"w13-周一-ls-lesson-6","startMinute":0,"endMinute":15},{"lessonId":"w13-周一-ls-lesson-7","startMinute":0,"endMinute":4},{"lessonId":"w13-周二-ls-lesson-1","startMinute":0,"endMinute":9},{"lessonId":"w13-周二-ls-lesson-2","startMinute":0,"endMinute":3}]],
  ["ls40-03151-03190","2027-01-21",39,[{"lessonId":"w13-周二-ls-lesson-3","startMinute":0,"endMinute":10},{"lessonId":"w13-周二-ls-lesson-4","startMinute":0,"endMinute":8},{"lessonId":"w13-周二-ls-lesson-5","startMinute":0,"endMinute":6},{"lessonId":"w13-周二-ls-lesson-6","startMinute":0,"endMinute":7},{"lessonId":"w13-周二-ls-lesson-7","startMinute":0,"endMinute":8}]],
  ["ls40-03190-03231","2027-01-22",41,[{"lessonId":"w13-周三-ls-lesson-1","startMinute":0,"endMinute":12},{"lessonId":"w13-周三-ls-lesson-2","startMinute":0,"endMinute":9},{"lessonId":"w13-周三-ls-lesson-3","startMinute":0,"endMinute":12},{"lessonId":"w13-周三-ls-lesson-4","startMinute":0,"endMinute":8}]],
  ["ls40-03231-03272","2027-01-25",41,[{"lessonId":"w13-周三-ls-lesson-4","startMinute":8,"endMinute":24},{"lessonId":"w13-周四-ls-lesson-1","startMinute":0,"endMinute":25}]],
  ["ls40-03272-03313","2027-01-26",41,[{"lessonId":"w13-周四-ls-lesson-1","startMinute":25,"endMinute":38},{"lessonId":"w13-周四-ls-lesson-2","startMinute":0,"endMinute":7},{"lessonId":"w13-周五-ls-lesson-1","startMinute":0,"endMinute":21}]],
  ["ls40-03313-03354","2027-01-27",41,[{"lessonId":"w13-周五-ls-lesson-2","startMinute":0,"endMinute":22},{"lessonId":"w13-周五-ls-lesson-3","startMinute":0,"endMinute":19}]],
  ["ls40-03354-03397","2027-01-28",43,[{"lessonId":"w14-周一-ls-lesson-1","startMinute":0,"endMinute":43}]],
  ["ls40-03397-03439","2027-01-29",42,[{"lessonId":"w14-周一-ls-lesson-2","startMinute":0,"endMinute":11},{"lessonId":"w14-周二-ls-lesson-1","startMinute":0,"endMinute":31}]],
  ["ls40-03439-03481","2027-02-01",42,[{"lessonId":"w14-周二-ls-lesson-2","startMinute":0,"endMinute":30},{"lessonId":"w14-周三-ls-lesson-1","startMinute":0,"endMinute":12}]],
  ["ls40-03481-03523","2027-02-02",42,[{"lessonId":"w14-周三-ls-lesson-1","startMinute":12,"endMinute":54}]],
  ["ls40-03523-03566","2027-02-03",43,[{"lessonId":"w14-周四-ls-lesson-1","startMinute":0,"endMinute":31},{"lessonId":"w14-周四-ls-lesson-2","startMinute":0,"endMinute":8},{"lessonId":"w14-周四-ls-lesson-3","startMinute":0,"endMinute":4}]],
  ["ls40-03566-03607","2027-02-04",41,[{"lessonId":"w14-周四-ls-lesson-4","startMinute":0,"endMinute":4},{"lessonId":"w14-周五-ls-lesson-1","startMinute":0,"endMinute":15},{"lessonId":"w14-周五-ls-lesson-2","startMinute":0,"endMinute":22}]],
  ["ls40-03607-03648","2027-02-05",41,[{"lessonId":"w14-周五-ls-lesson-2","startMinute":22,"endMinute":41},{"lessonId":"w15-周一-ls-lesson-1","startMinute":0,"endMinute":22}]],
  ["ls40-03648-03687","2027-02-08",39,[{"lessonId":"w15-周一-ls-lesson-2","startMinute":0,"endMinute":13},{"lessonId":"w15-周一-ls-lesson-3","startMinute":0,"endMinute":26}]],
  ["ls40-03687-03726","2027-02-09",39,[{"lessonId":"w15-周一-ls-lesson-3","startMinute":26,"endMinute":45},{"lessonId":"w15-周二-ls-lesson-1","startMinute":0,"endMinute":20}]],
  ["ls40-03726-03765","2027-02-10",39,[{"lessonId":"w15-周二-ls-lesson-1","startMinute":20,"endMinute":44},{"lessonId":"w15-周三-ls-lesson-1","startMinute":0,"endMinute":15}]],
  ["ls40-03765-03804","2027-02-11",39,[{"lessonId":"w15-周三-ls-lesson-1","startMinute":15,"endMinute":44},{"lessonId":"w15-周四-ls-lesson-1","startMinute":0,"endMinute":10}]],
  ["ls40-03804-03842","2027-02-12",38,[{"lessonId":"w15-周四-ls-lesson-1","startMinute":10,"endMinute":48}]],
  ["ls40-03842-03882","2027-02-15",40,[{"lessonId":"w15-周五-ls-lesson-1","startMinute":0,"endMinute":40}]],
  ["ls40-03882-03922","2027-02-16",40,[{"lessonId":"w15-周五-ls-lesson-1","startMinute":40,"endMinute":48},{"lessonId":"w16-周一-ls-lesson-1","startMinute":0,"endMinute":32}]],
  ["ls40-03922-03962","2027-02-17",40,[{"lessonId":"w16-周一-ls-lesson-1","startMinute":32,"endMinute":48},{"lessonId":"w16-周二-ls-lesson-1","startMinute":0,"endMinute":24}]],
  ["ls40-03962-04002","2027-02-18",40,[{"lessonId":"w16-周二-ls-lesson-1","startMinute":24,"endMinute":48},{"lessonId":"w16-周三-ls-lesson-1","startMinute":0,"endMinute":16}]],
  ["ls40-04002-04042","2027-02-19",40,[{"lessonId":"w16-周三-ls-lesson-1","startMinute":16,"endMinute":48},{"lessonId":"w16-周四-ls-lesson-1","startMinute":0,"endMinute":8}]],
  ["ls40-04042-04081","2027-02-22",39,[{"lessonId":"w16-周四-ls-lesson-1","startMinute":8,"endMinute":47}]],
  ["ls40-04081-04122","2027-02-23",41,[{"lessonId":"w16-周五-ls-lesson-1","startMinute":0,"endMinute":41}]],
  ["ls40-04122-04163","2027-02-24",41,[{"lessonId":"w16-周五-ls-lesson-1","startMinute":41,"endMinute":59},{"lessonId":"w17-周一-ls-lesson-1","startMinute":0,"endMinute":23}]],
  ["ls40-04163-04203","2027-02-25",40,[{"lessonId":"w17-周一-ls-lesson-1","startMinute":23,"endMinute":32},{"lessonId":"w17-周一-ls-lesson-2","startMinute":0,"endMinute":31}]],
  ["ls40-04203-04247","2027-02-26",44,[{"lessonId":"w17-周二-ls-lesson-1","startMinute":0,"endMinute":44}]],
  ["ls40-04247-04290","2027-03-01",43,[{"lessonId":"w17-周二-ls-lesson-1","startMinute":44,"endMinute":59},{"lessonId":"w17-周三-ls-lesson-1","startMinute":0,"endMinute":28}]],
  ["ls40-04290-04328","2027-03-02",38,[{"lessonId":"w17-周三-ls-lesson-2","startMinute":0,"endMinute":38}]],
  ["ls40-04328-04366","2027-03-03",38,[{"lessonId":"w17-周四-ls-lesson-1","startMinute":0,"endMinute":38}]],
  ["ls40-04366-04402","2027-03-04",36,[{"lessonId":"w17-周五-ls-lesson-1","startMinute":0,"endMinute":36}]],
  ["ls40-04402-04443","2027-03-05",41,[{"lessonId":"w17-周五-ls-lesson-2","startMinute":0,"endMinute":19},{"lessonId":"w18-周一-ls-lesson-1","startMinute":0,"endMinute":22}]],
  ["ls40-04443-04484","2027-03-08",41,[{"lessonId":"w18-周一-ls-lesson-1","startMinute":22,"endMinute":46},{"lessonId":"w18-周二-ls-lesson-1","startMinute":0,"endMinute":17}]],
  ["ls40-04484-04524","2027-03-09",40,[{"lessonId":"w18-周二-ls-lesson-1","startMinute":17,"endMinute":33},{"lessonId":"w18-周二-ls-lesson-2","startMinute":0,"endMinute":24}]],
  ["ls40-04524-04564","2027-03-10",40,[{"lessonId":"w18-周二-ls-lesson-2","startMinute":24,"endMinute":33},{"lessonId":"w18-周三-ls-lesson-1","startMinute":0,"endMinute":31}]],
  ["ls40-04564-04607","2027-03-11",43,[{"lessonId":"w18-周三-ls-lesson-2","startMinute":0,"endMinute":31},{"lessonId":"w18-周四-ls-lesson-1","startMinute":0,"endMinute":12}]],
  ["ls40-04607-04650","2027-03-12",43,[{"lessonId":"w18-周四-ls-lesson-1","startMinute":12,"endMinute":31},{"lessonId":"w18-周四-ls-lesson-2","startMinute":0,"endMinute":24}]],
  ["ls40-04650-04693","2027-03-15",43,[{"lessonId":"w18-周四-ls-lesson-2","startMinute":24,"endMinute":34},{"lessonId":"w18-周五-ls-lesson-1","startMinute":0,"endMinute":33}]],
  ["ls40-04693-04734","2027-03-16",41,[{"lessonId":"w19-周一-ls-lesson-1","startMinute":0,"endMinute":23},{"lessonId":"w19-周一-ls-lesson-2","startMinute":0,"endMinute":18}]],
  ["ls40-04734-04774","2027-03-17",40,[{"lessonId":"w19-周一-ls-lesson-2","startMinute":18,"endMinute":58}]],
  ["ls40-04774-04810","2027-03-18",36,[{"lessonId":"w19-周二-ls-lesson-1","startMinute":0,"endMinute":36}]],
  ["ls40-04810-04845","2027-03-19",35,[{"lessonId":"w19-周二-ls-lesson-1","startMinute":36,"endMinute":47},{"lessonId":"w19-周三-ls-lesson-1","startMinute":0,"endMinute":24}]],
  ["ls40-04845-04883","2027-03-22",38,[{"lessonId":"w19-周三-ls-lesson-2","startMinute":0,"endMinute":25},{"lessonId":"w19-周四-ls-lesson-1","startMinute":0,"endMinute":13}]],
  ["ls40-04883-04920","2027-03-23",37,[{"lessonId":"w19-周四-ls-lesson-1","startMinute":13,"endMinute":50}]],
  ["ls40-04920-04959","2027-03-24",39,[{"lessonId":"w19-周五-ls-lesson-1","startMinute":0,"endMinute":39}]],
  ["ls40-04959-04997","2027-03-25",38,[{"lessonId":"w19-周五-ls-lesson-1","startMinute":39,"endMinute":52},{"lessonId":"w20-周一-ls-lesson-1","startMinute":0,"endMinute":25}]],
  ["ls40-04997-05038","2027-03-26",41,[{"lessonId":"w20-周一-ls-lesson-2","startMinute":0,"endMinute":31},{"lessonId":"w20-周二-ls-lesson-1","startMinute":0,"endMinute":10}]],
  ["ls40-05038-05079","2027-03-29",41,[{"lessonId":"w20-周二-ls-lesson-1","startMinute":10,"endMinute":42},{"lessonId":"w20-周三-ls-lesson-1","startMinute":0,"endMinute":9}]],
  ["ls40-05079-05119","2027-03-30",40,[{"lessonId":"w20-周三-ls-lesson-1","startMinute":9,"endMinute":49}]],
  ["ls40-05119-05155","2027-03-31",36,[{"lessonId":"w20-周三-ls-lesson-2","startMinute":0,"endMinute":18},{"lessonId":"w20-周四-ls-lesson-1","startMinute":0,"endMinute":18}]],
  ["ls40-05155-05196","2027-04-01",41,[{"lessonId":"w20-周四-ls-lesson-2","startMinute":0,"endMinute":41}]],
  ["ls40-05196-05237","2027-04-02",41,[{"lessonId":"w20-周四-ls-lesson-2","startMinute":41,"endMinute":59},{"lessonId":"w20-周五-ls-lesson-1","startMinute":0,"endMinute":23}]],
  ["ls40-05237-05277","2027-04-05",40,[{"lessonId":"w20-周五-ls-lesson-1","startMinute":23,"endMinute":32},{"lessonId":"w21-周一-ls-lesson-1","startMinute":0,"endMinute":31}]],
  ["ls40-05277-05317","2027-04-06",40,[{"lessonId":"w21-周二-ls-lesson-1","startMinute":0,"endMinute":31},{"lessonId":"w21-周二-ls-lesson-2","startMinute":0,"endMinute":9}]],
  ["ls40-05317-05357","2027-04-07",40,[{"lessonId":"w21-周二-ls-lesson-2","startMinute":9,"endMinute":27},{"lessonId":"w21-周三-ls-lesson-1","startMinute":0,"endMinute":22}]],
  ["ls40-05357-05396","2027-04-08",39,[{"lessonId":"w21-周三-ls-lesson-1","startMinute":22,"endMinute":31},{"lessonId":"w21-周三-ls-lesson-2","startMinute":0,"endMinute":30}]],
  ["ls40-05396-05440","2027-04-09",44,[{"lessonId":"w21-周四-ls-lesson-1","startMinute":0,"endMinute":44}]],
  ["ls40-05440-05477","2027-04-12",37,[{"lessonId":"w21-周四-ls-lesson-2","startMinute":0,"endMinute":11},{"lessonId":"w21-周五-ls-lesson-1","startMinute":0,"endMinute":26}]],
  ["ls40-05477-05514","2027-04-13",37,[{"lessonId":"w21-周五-ls-lesson-1","startMinute":26,"endMinute":52},{"lessonId":"w22-周一-ls-lesson-1","startMinute":0,"endMinute":11}]],
  ["ls40-05514-05552","2027-04-14",38,[{"lessonId":"w22-周一-ls-lesson-2","startMinute":0,"endMinute":17},{"lessonId":"w22-周一-ls-lesson-3","startMinute":0,"endMinute":21}]],
  ["ls40-05552-05590","2027-04-15",38,[{"lessonId":"w22-周一-ls-lesson-3","startMinute":21,"endMinute":38},{"lessonId":"w22-周二-ls-lesson-1","startMinute":0,"endMinute":21}]],
  ["ls40-05590-05632","2027-04-16",42,[{"lessonId":"w22-周二-ls-lesson-2","startMinute":0,"endMinute":19},{"lessonId":"w22-周三-ls-lesson-1","startMinute":0,"endMinute":23}]],
  ["ls40-05632-05671","2027-04-19",39,[{"lessonId":"w22-周三-ls-lesson-2","startMinute":0,"endMinute":8},{"lessonId":"w22-周三-ls-lesson-3","startMinute":0,"endMinute":31}]],
  ["ls40-05671-05716","2027-04-20",45,[{"lessonId":"w22-周四-ls-lesson-1","startMinute":0,"endMinute":28},{"lessonId":"w22-周四-ls-lesson-2","startMinute":0,"endMinute":17}]],
  ["ls40-05716-05755","2027-04-21",39,[{"lessonId":"w22-周五-ls-lesson-1","startMinute":0,"endMinute":39}]],
  ["ls40-05755-05792","2027-04-22",37,[{"lessonId":"w22-周五-ls-lesson-2","startMinute":0,"endMinute":10},{"lessonId":"w23-周一-ls-lesson-1","startMinute":0,"endMinute":27}]],
  ["ls40-05792-05833","2027-04-23",41,[{"lessonId":"w23-周一-ls-lesson-2","startMinute":0,"endMinute":41}]],
  ["ls40-05833-05872","2027-04-26",39,[{"lessonId":"w23-周二-ls-lesson-1","startMinute":0,"endMinute":6},{"lessonId":"w23-周二-ls-lesson-2","startMinute":0,"endMinute":26},{"lessonId":"w23-周二-ls-lesson-3","startMinute":0,"endMinute":7}]],
  ["ls40-05872-05910","2027-04-27",38,[{"lessonId":"w23-周二-ls-lesson-3","startMinute":7,"endMinute":27},{"lessonId":"w23-周三-ls-lesson-1","startMinute":0,"endMinute":18}]],
  ["ls40-05910-05948","2027-04-28",38,[{"lessonId":"w23-周三-ls-lesson-1","startMinute":18,"endMinute":56}]],
  ["ls40-05948-05987","2027-04-29",39,[{"lessonId":"w23-周四-ls-lesson-1","startMinute":0,"endMinute":6},{"lessonId":"w23-周四-ls-lesson-2","startMinute":0,"endMinute":4},{"lessonId":"w23-周四-ls-lesson-3","startMinute":0,"endMinute":20},{"lessonId":"w23-周五-ls-lesson-1","startMinute":0,"endMinute":9}]],
  ["ls40-05987-06026","2027-04-30",39,[{"lessonId":"w23-周五-ls-lesson-1","startMinute":9,"endMinute":48}]],
  ["ls40-06026-06071","2027-05-03",45,[{"lessonId":"w24-周一-ls-lesson-1","startMinute":0,"endMinute":29},{"lessonId":"w24-周一-ls-lesson-2","startMinute":0,"endMinute":16}]],
  ["ls40-06071-06111","2027-05-04",40,[{"lessonId":"w24-周二-ls-lesson-1","startMinute":0,"endMinute":40}]],
  ["ls40-06111-06151","2027-05-05",40,[{"lessonId":"w24-周二-ls-lesson-1","startMinute":40,"endMinute":47},{"lessonId":"w24-周三-ls-lesson-1","startMinute":0,"endMinute":23},{"lessonId":"w24-周三-ls-lesson-2","startMinute":0,"endMinute":10}]],
  ["ls40-06151-06191","2027-05-06",40,[{"lessonId":"w24-周三-ls-lesson-2","startMinute":10,"endMinute":22},{"lessonId":"w24-周四-ls-lesson-1","startMinute":0,"endMinute":28}]],
  ["ls40-06191-06231","2027-05-07",40,[{"lessonId":"w24-周四-ls-lesson-1","startMinute":28,"endMinute":39},{"lessonId":"w24-周五-ls-lesson-1","startMinute":0,"endMinute":29}]],
  ["ls40-06231-06271","2027-05-10",40,[{"lessonId":"w24-周五-ls-lesson-1","startMinute":29,"endMinute":38},{"lessonId":"w24-周五-ls-lesson-2","startMinute":0,"endMinute":13},{"lessonId":"w24-周五-ls-lesson-3","startMinute":0,"endMinute":18}]],
];
const EXPECTED_COURSES = [
  {
    title: "易播加密播放器Linux服务端", firstWeek: 1, lastWeek: 6,
    sections: [
      [2741, 609],
      [2744, 491],
      [2743, 891],
      [2740, 328],
      [2742, 429],
      [2745, 811],
      [2748, 1310],
      [2747, 664],
      [2751, 1777],
      [2750, 2126],
      [2746, 57],
      [2754, 2304],
      [2749, 1029],
      [2752, 1400],
      [2755, 2219],
      [2753, 633],
      [2756, 2442],
      [2757, 2461],
      [2758, 2898],
      [2762, 4240],
      [2761, 3056],
      [2763, 4435],
      [2760, 484],
      [2759, 738],
      [2765, 1193],
      [2768, 2457],
      [2767, 1329],
      [2770, 3268],
      [2764, 602],
      [2766, 2332],
      [2769, 1920],
      [2771, 1634],
      [2773, 2491],
      [2774, 2221],
      [2772, 1829],
      [2776, 1807],
      [2775, 1188],
      [2777, 2061],
      [2778, 2070],
      [2779, 1862],
      [2780, 2281],
      [2782, 2502],
      [2786, 2604],
      [2784, 1932],
      [2781, 726],
      [2785, 1287],
      [2783, 1727],
      [2787, 1209],
      [2788, 900],
      [2789, 819],
      [2790, 1648],
      [2792, 2142],
      [2791, 1386],
      [2794, 2529],
      [2793, 851],
    ]
  },
  {
    title: "云助教", firstWeek: 9, lastWeek: 17,
    sections: [
      [3762, 928],
      [3768, 690],
      [3773, 783],
      [3771, 505],
      [3832, 1964],
      [3996, 2060],
      [3831, 1431],
      [3775, 1315],
      [3780, 984],
      [3781, 1504],
      [3786, 1985],
      [3812, 1576],
      [3782, 2861],
      [3783, 1859],
      [3784, 1633],
      [4042, 1480],
      [3830, 944],
      [3813, 1913],
      [3814, 3717],
      [3999, 3206],
      [3816, 2274],
      [3817, 2715],
      [3818, 5038],
      [3819, 4720],
      [3796, 461],
      [3800, 2166],
      [3828, 825],
      [3829, 3382],
      [4082, 2371],
      [3779, 866],
      [3794, 2248],
      [4077, 376],
      [4078, 712],
      [4079, 1501],
      [4080, 1274],
      [4083, 2809],
      [4081, 2940],
      [3798, 2219],
      [3802, 1583],
      [3803, 929],
      [3804, 2082],
      [3805, 1175],
      [4085, 2549],
      [4084, 1238],
      [4086, 2728],
      [4091, 3234],
      [4092, 3027],
      [4087, 2403],
      [4088, 2863],
      [4089, 2708],
      [4090, 4942],
      [3822, 1290],
      [3823, 1822],
      [3821, 1254],
      [3824, 936],
      [3825, 1198],
      [3827, 3245],
      [4097, 2515],
      [4098, 2751],
      [4099, 2753],
      [4100, 2552],
      [3820, 3755],
    ]
  },
  {
    title: "Course Studio", firstWeek: 20, lastWeek: 31,
    sections: [
      [4516, 455],
      [4517, 1576],
      [4519, 1517],
      [4656, 133],
      [4660, 112],
      [4661, 2194],
      [4662, 611],
      [4664, 1560],
      [4663, 883],
      [4521, 1557],
      [4523, 1377],
      [4524, 947],
      [4636, 1908],
      [4638, 1120],
      [4665, 952],
      [4666, 8195],
      [4667, 995],
      [4668, 3593],
      [4669, 864],
      [4670, 5761],
      [4634, 1266],
      [4671, 701],
      [4672, 641],
      [4673, 7806],
      [4534, 907],
      [4546, 1189],
      [4545, 904],
      [4674, 914],
      [4675, 5449],
      [4657, 217],
      [4658, 697],
      [4543, 871],
      [4551, 1078],
      [4677, 701],
      [4676, 6504],
      [4678, 1777],
      [4679, 4285],
      [4549, 1123],
      [4547, 1030],
      [4659, 737],
      [4680, 658],
      [4681, 908],
      [4641, 938],
      [4559, 1126],
      [4558, 1631],
      [4557, 829],
      [4553, 1289],
      [4644, 637],
    ]
  },
];

const EXPECTED_ZERO_VOICE = [
  [
    57,
    "55-FLV解复用实战",
    4710
  ],
  [
    58,
    "56-音频解码实战",
    2240
  ],
  [
    59,
    "57-视频解码实战",
    968
  ],
  [
    60,
    "58_1-MP4封装格式剖析",
    4103
  ],
  [
    61,
    "59-2-MP4解封装",
    4164
  ],
  [
    62,
    "60-AVIO内存输入模式",
    4347
  ],
  [
    63,
    "61-音频处理基本概念及音频重采样",
    4612
  ],
  [
    64,
    "62-音频处理基本概念及音频重采样",
    4366
  ],
  [
    65,
    "63-音频编码实战",
    2776
  ],
  [
    66,
    "64-H264编码原理详解",
    4336
  ],
  [
    67,
    "65-视频编码实战",
    2482
  ],
  [
    69,
    "66-音视频H264和AAC合成FLV实战(ffmpeg6.0版本)",
    6977
  ],
  [
    70,
    "67_MP4合成实战1-框架分析",
    749
  ],
  [
    71,
    "68_MP4合成实战2-muxer实现",
    2582
  ],
  [
    72,
    "69_MP4合成实战3-音视频编码实现",
    2651
  ],
  [
    73,
    "70_MP4合成实战4-合成mp4",
    5758
  ],
  [
    74,
    "71_MP4合成实战5-优化",
    3092
  ],
  [
    75,
    "01-H265-NALU分析和解码",
    904
  ],
  [
    76,
    "02-H265编码实践",
    1610
  ],
  [
    77,
    "03-nvdia硬件编码H264",
    1375
  ],
  [
    78,
    "04-ffmpeg硬件解码",
    2541
  ],
  [
    79,
    "05-FFmpeg两路音视频混流实现-音频混流",
    3596
  ],
  [
    80,
    "73-FFmpeg过滤器框架分析",
    705
  ],
  [
    81,
    "74-视频过滤器实战",
    1250
  ],
  [
    82,
    "75-音频过滤器实战",
    2320
  ],
  [
    83,
    "76-FFmpeg filter补充讲解",
    2716
  ],
  [
    133,
    "122-RTMP流媒体服务器搭建",
    1698
  ],
  [
    134,
    "123-RTMP协议剖析",
    7877
  ],
  [
    135,
    "124-RTMP推流实战",
    8167
  ],
  [
    136,
    "125-RTMP拉流实战",
    9136
  ],
  [
    137,
    "屏幕录制+推流项目框架讲解",
    1049
  ],
  [
    138,
    "126- HLS流媒体服务器配置",
    1723
  ],
  [
    139,
    "127 HLS框架分析",
    1587
  ],
  [
    140,
    "128- m3u8协议详解",
    523
  ],
  [
    141,
    "129-TS协议解析",
    2115
  ],
  [
    142,
    "130-HLS抓包分析5",
    1356
  ],
  [
    143,
    "131-HTTP协议分析",
    1383
  ],
  [
    146,
    "133（补充） nginx-hls-多码率测试环境搭建",
    3449
  ],
  [
    147,
    "133（补充） TS协议补充",
    1478
  ],
  [
    150,
    "158-RTSP基本原理",
    1982
  ],
  [
    151,
    "159-RTP协议讲解",
    1419
  ],
  [
    152,
    "160-RTP之H264封包和解包1-封包原理",
    2153
  ],
  [
    153,
    "161-RTP之H264封包和解包2-编码实现",
    5408
  ],
  [
    154,
    "162-RTP之AAC封包和解包1-软件框架分析",
    3928
  ],
  [
    155,
    "163-RTP之AAC封包和解包2-原理和源码解析",
    3023
  ],
  [
    156,
    "164-RTSP协议交互流程",
    2280
  ],
  [
    157,
    "165-SDP协议分析",
    1574
  ],
  [
    158,
    "166-rtcp详解",
    5258
  ],
  [
    171,
    "什么是WebRTC",
    160
  ],
  [
    172,
    "WebRTC框架",
    299
  ],
  [
    174,
    " WebRTC通话原理1-STUN",
    1239
  ],
  [
    175,
    "WebRTC通话原理2-TURN",
    425
  ],
  [
    176,
    "WebRTC通话原理3-信令服务器",
    559
  ],
  [
    177,
    "WebRTC通话原理4-一对一通话-补充",
    1034
  ],
  [
    180,
    "coturn安装",
    189
  ],
  [
    181,
    "coturn服务器测试",
    386
  ],
  [
    194,
    "信令服务器map实战",
    703
  ],
  [
    195,
    "一对一通话原理",
    1445
  ],
  [
    196,
    "信令协议设计",
    2262
  ],
  [
    197,
    "RTCPeerConnection补充",
    415
  ],
  [
    202,
    "WebRTC API讲解",
    667
  ],
  [
    203,
    "offer_answer",
    3679
  ],
  [
    253,
    "136-SRS流媒体服务器开发概述",
    2772
  ],
  [
    254,
    "137-SRS流媒体框架入门",
    3939
  ],
  [
    255,
    "138-SRS流媒体服务器-推流框架分析",
    3725
  ],
  [
    256,
    "139-SRS流媒体服务器-RTMP拉流框架分析",
    1874
  ],
  [
    257,
    "140-SRS流媒体服务器-RTMP协议",
    4041
  ],
  [
    258,
    "141-SRS流媒体服务器-RTMP协议2",
    1377
  ],
  [
    259,
    "142-SRS流媒体服务器-RTMP推流消息处理",
    3505
  ],
  [
    260,
    "143-SRS流媒体服务器-HTTP-FLV框架分析",
    2837
  ],
  [
    261,
    "144-1SRS服务器-HTTP-FLV-配置文件",
    1449
  ],
  [
    262,
    "145-2SRS服务器-HTTP-FLV-推拉",
    1522
  ],
  [
    263,
    "146-3SRS服务器-HTTP-FLV-拉流1",
    2999
  ],
  [
    264,
    "147-4SRS服务器-HTTP-FLV-拉流2",
    3121
  ],
  [
    265,
    "148-SRS服务器-Forward集群",
    1521
  ],
  [
    266,
    "149-SRS服务器-Forward源码分析2",
    1853
  ],
  [
    267,
    "150-SRS流媒体服务器-edge集群-1",
    2491
  ],
  [
    268,
    "151-SRS流媒体服务器-edge集群-2",
    2956
  ],
  [
    269,
    "152-SRS流媒体服务器-edge集群-3",
    1073
  ],
  [
    270,
    "153-SRS流媒体服务器-HLS文件配置",
    1067
  ],
  [
    271,
    "154-SRS流媒体服务器-HLS拉流分析1",
    3545
  ],
  [
    272,
    "156-SRS流媒体服务器-HLS拉流分析3",
    3809
  ],
  [
    273,
    "155-SRS流媒体服务器-HLS拉流分析2",
    1848
  ],
  [
    274,
    "1-ZLMediaKit环境搭建-RTSP",
    1642
  ],
  [
    275,
    "2-ZLMediaKit网络模型框架分析",
    1841
  ],
  [
    276,
    "3-1-RTSP推拉流框架分析-TCP模型",
    1777
  ],
  [
    277,
    "3-2-RTSP推拉流框架分析-TCP模型",
    2658
  ],
  [
    278,
    "3-3-RTSP推拉流框架分析-TCP模型",
    659
  ],
  [
    279,
    "4-ZLMediaKit推流详解-TCP模式",
    3120
  ],
  [
    280,
    "5-ZLM-RTSP拉流详解-TCP模式-bk",
    653
  ],
  [
    281,
    "6-RTSP推拉流框架分析-UDP模型",
    1011
  ],
  [
    285,
    "261-SRS配置支持WebRTC推拉流1",
    1368
  ],
  [
    286,
    "262-SRS配置支持WebRTC推拉流2",
    463
  ],
  [
    287,
    "263-SRS RTMP端口监听逻辑",
    1865
  ],
  [
    288,
    "264-SRS  RTMP推流拉流怎么创建连接",
    1665
  ],
  [
    289,
    "265-SRS RTMP推流读取数据,拉流转发数据",
    1047
  ],
  [
    290,
    "266-SRS 哪些配置文件会影响RTMP的延迟",
    2355
  ],
  [
    291,
    "267-SRS配置支持WebRTC直播",
    615
  ],
  [
    292,
    "268- WebRTC 1v1通话1-配置和测试",
    1631
  ],
  [
    293,
    "269-WebRTC 1v1通话2-逻辑分析",
    2467
  ],
  [
    294,
    "270-rtmp2webrtc测试环境-",
    379
  ],
  [
    295,
    "271-rtmp2webrtc提出问题-灵魂拷问-",
    1551
  ],
  [
    296,
    "272-rtmp2webrtc协议转换",
    1628
  ],
  [
    297,
    "273-RTMP2WebRTC逻辑",
    3355
  ],
  [
    298,
    "274-WebRTC2Rtmp测试环境",
    350
  ],
  [
    299,
    "275-WebRTC2Rtmp协议转换",
    236
  ],
  [
    300,
    "276-WebRTC2Rtmp逻辑分析",
    1204
  ],
  [
    301,
    "277-SRS-ICE交互分析",
    2900
  ],
  [
    302,
    "278-SRS-DTLS握手",
    1723
  ],
  [
    303,
    "279-SRS-SRTP加密传输",
    937
  ],
  [
    304,
    "280-SRS-SDP详解1",
    2831
  ],
  [
    305,
    "281-SRS-SDP详解2",
    1383
  ],
  [
    307,
    "283参考资料-WebRTC的拥塞控制",
    4602
  ],
  [
    355,
    "1-WHIP-WHEP协议介绍",
    7439
  ],
  [
    356,
    "2-WebRTC基础与SDP处理",
    7508
  ],
  [
    357,
    "3-WHIP推流服务实现",
    6964
  ],
  [
    358,
    "4-WHEP拉流服务实现",
    7424
  ]
];

const html = fs.readFileSync(path.resolve(__dirname, '..', 'study-tracker.html'), 'utf8');
const embedded = html.match(/\bconst DATA\s*=\s*(\{[\s\S]*?\})\s*;\s*<\/script>/);
assert.ok(embedded, 'The delivered HTML contains the complete schedule');
const data = JSON.parse(embedded[1]);
const tasks = data.weeks.flatMap(week => week.tasks);
const byId = new Map(tasks.map(task => [task.id, task]));
const videos = tasks.filter(task => task.track === 'ydy' && task.learningSegments?.length);
const practice = tasks.filter(task => task.id.startsWith('edoyun-module-v1-') && task.optional !== true);
const reviews = tasks.filter(task => task.track === 'review');
const workflow = data.careerWorkflow;
const preparation = workflow.preparationTaskIds.map(id => byId.get(id));
const teacher = byId.get(workflow.teacherTaskId);
const interviews = workflow.interviewTaskIds.map(id => byId.get(id));
const required = tasks.filter(task => task.optional !== true);
const learning = required.filter(task => task.track === 'ls' || task.track === 'ydy');
const zeroVoice = tasks.filter(task => task.track === 'ls' && task.activity === 'video');
const curriculumContent = task => Object.fromEntries(Object.entries(task).filter(([key]) => !new Set(
  ['date', 'day', 'week', 'startDate', 'endDate', 'workSessions', 'prerequisiteTaskIds', 'summary', 'duration']).has(key)));
const sum = values => values.reduce((total, value) => total + value, 0);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const RETIRED_FLV_IDS = new Set(['ls40-00649-00688', 'ls40-00688-00726']);
const RETIRED_FLV_LESSON_IDS = ['w03-周三-ls-lesson-1', 'w03-周四-ls-lesson-1'];
const isoDate = instant => new Date(instant).toISOString().slice(0, 10);
const weekday = date => new Date(`${date}T12:00:00Z`).getUTCDay();
const almostEqual = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-7, `${message}: ${actual} != ${expected}`);
const endDate = task => task.endDate || task.date;
const sessions = task => task.onDemand === true || ['external', 'after-event'].includes(task.scheduleKind) ? [] : task.workSessions?.length ? task.workSessions
  : [{ date: task.date, minutes: task.durationMinutes }];
const allSessions = tasks.flatMap(task => sessions(task).map(session => ({ ...session, task })));
const expectedSections = new Map(EXPECTED_COURSES.flatMap(course => course.sections.map(([id, seconds]) =>
  [String(id), { course, seconds }])));
const ancestorCache = new Map();
function ancestors(task, visiting = new Set()) {
  assert.ok(!visiting.has(task.id), `${task.id}: no prerequisite cycle`);
  if (ancestorCache.has(task.id)) return ancestorCache.get(task.id);
  const next = new Set(visiting).add(task.id), result = new Set();
  for (const id of task.prerequisiteTaskIds || []) {
    const parent = byId.get(id);
    assert.ok(parent, `${task.id}: prerequisite ${id} exists`);
    result.add(id);
    for (const ancestor of ancestors(parent, next)) result.add(ancestor);
  }
  ancestorCache.set(task.id, result);
  return result;
}

test('the calendar stores each learning module once and charges sessions to their actual dates and weeks', () => {
  assert.equal(byId.size, tasks.length);
  assert.equal(data.weeks[0].start, '2026-10-05');
  assert.ok(data.weeks.length < 59, 'Retired template weeks are not retained as artificial required work');
  assert.equal(new Set(data.weeks.map(week => week.topic)).size, data.weeks.length);
  for (const [index, week] of data.weeks.entries()) {
    assert.equal(week.week, index + 1);
    assert.equal(week.start, isoDate(Date.parse('2026-10-05T00:00:00Z') + index * 7 * 86400000));
    assert.equal(week.end, isoDate(Date.parse(`${week.start}T00:00:00Z`) + 6 * 86400000));
    assert.ok(week.topic?.trim());
    for (const task of week.tasks) {
      assert.equal(task.week, week.week);
      if (['external', 'after-event'].includes(task.scheduleKind)) {
        assert.equal(task.date, undefined, 'An event or relative outline entry has no invented calendar date');
        assert.deepEqual(task.workSessions, []);
      } else assert.ok(week.start <= task.date && task.date <= week.end);
      assert.ok(task.title?.trim() && Number.isFinite(task.durationMinutes));
      assert.ok(task.scheduleKind === 'external' ? task.durationMinutes === 0 : task.durationMinutes > 0);
      if (task.workSessions?.length) {
        assert.equal(task.date, task.workSessions[0].date);
        assert.equal(endDate(task), task.workSessions.at(-1).date);
        assert.deepEqual(task.workSessions.map(item => item.date), task.workSessions.map(item => item.date).sort());
        assert.equal(new Set(task.workSessions.map(item => item.date)).size, task.workSessions.length,
          'One module has at most one planned session on a given day');
        almostEqual(sum(task.workSessions.map(item => item.minutes)), task.durationMinutes, `${task.id}: module estimate equals planned sessions`);
      }
    }
    const planned = allSessions.filter(session => week.start <= session.date && session.date <= week.end);
    almostEqual(week.scheduledMinutes, sum(planned.map(session => session.minutes)), `${week.week}: weekly load comes from sessions, not module start dates`);
    assert.ok(week.scheduledMinutes <= 12 * 60 + 1e-7, `${week.week}: fixed sessions remain within the accepted weekly maximum`);
    almostEqual(week.totalMin, sum(planned.filter(session => session.task.track === 'ls').map(session => session.minutes)), 'Zero Voice subtotal remains genuine video time');
  }
  for (const task of tasks.filter(item => item.workSessions?.length > 1))
    assert.equal(tasks.filter(item => item.id === task.id).length, 1, 'Cross-week continuation cannot create new duplicate check-ins');
});

test('daily scheduling respects Zero Voice weekdays, course-specific video limits and project practice capacity', () => {
  assert.deepEqual(data.planRhythm.afterCourseWeekdays.interviewDays, []);
  assert.deepEqual(data.planRhythm.afterCourseWeekdays.projectDays, [1, 2, 3, 4, 5]);
  assert.equal(data.planRhythm.afterCourseWeekdays.minutes, 40);
  assert.deepEqual(data.planRhythm.careerWeekdays.days, [1, 2, 3, 4, 5]);
  const dates = [...new Set(allSessions.map(session => session.date))].sort();
  for (const date of dates) {
    const assigned = allSessions.filter(session => session.date === date);
    assert.notEqual(weekday(date), 0, 'Sunday has no fixed sessions');
    assert.ok(assigned.every(session => Number.isFinite(session.minutes) && session.minutes > 0));
    if (weekday(date) !== 6) {
      if (date <= '2027-03-23') {
        assert.equal(assigned.length, 1);
        assert.equal(assigned[0].task.track, 'ls');
        almostEqual(assigned[0].minutes, date === '2027-03-23' ? 2133 / 60 : 40, 'Every daily course slot is exactly forty minutes except the final remainder');
      } else assert.ok(sum(assigned.map(session => session.minutes)) <= 40,
        `${date}: module totals cannot be mistaken for a weekday session`);
      assert.ok(assigned.every(session => session.task.track !== 'ydy' || !session.task.learningSegments?.length), 'Edoyun video stays on Saturday');
    } else if (date >= data.planPhases.find(phase => phase.id === 'career').start) {
      assert.ok(assigned.every(session => workflow.skillPreparationTaskIds.includes(session.task.id)), 'Career Saturdays are reserved for skill modules');
      assert.ok(sum(assigned.map(session => session.minutes)) <= 300);
    } else {
      assert.ok(assigned.every(session => session.task.track === 'ydy'));
      const caps = { yibo: 300, yunzhujiao: 240, 'studio-course': 120 };
      for (const [projectId, cap] of Object.entries(caps))
        assert.ok(sum(assigned.filter(session => session.task.projectId === projectId && session.task.learningSegments?.length)
          .map(session => session.minutes)) <= cap + 1e-7, `${projectId}: its actual video cap survives`);
      const week = data.weeks.find(item => item.start <= date && date <= item.end);
      assert.ok(sum(assigned.filter(session => !session.task.learningSegments?.length).map(session => session.minutes))
        <= (week.week <= 17 ? 210 : 300), `${date}: practice has its own accepted Saturday capacity`);
    }
  }
});

test('after Zero Voice ends, available weekdays continue ready course modules without inventing work before their source videos', () => {
  const first = data.planRhythm.weekdayTransitionDate;
  const last = data.planRhythm.courseWrapUpDate;
  assert.equal(first, '2027-03-24');
  for (let instant = Date.parse(`${first}T00:00:00Z`); instant <= Date.parse(`${last}T00:00:00Z`); instant += 86400000) {
    const date = isoDate(instant);
    if (weekday(date) === 0 || weekday(date) === 6) continue;
    const work = allSessions.filter(session => session.date === date);
    const ready = practice.filter(task => endDate(task) >= date
      && (task.prerequisiteTaskIds || []).every(id => endDate(byId.get(id)) <= date));
    if (ready.length) assert.ok(work.length > 0, `${date}: a ready unfinished course module uses the available weekday slot`);
    assert.ok(work.every(session => session.task.id.startsWith('edoyun-module-v1-') && session.task.optional !== true));
    assert.ok(sum(work.map(session => session.minutes)) <= 40);
  }
  const weekdayPractice = allSessions.filter(session => session.task.track === 'ydy' && !session.task.learningSegments?.length
    && weekday(session.date) >= 1 && weekday(session.date) <= 5);
  assert.ok(weekdayPractice[0].date <= '2027-03-29', 'The first ready March module must use released weekdays rather than wait until May');
  assert.ok(sum(weekdayPractice.map(session => session.minutes)) > 180, 'Newly available weekdays actually carry more practice than the former May-only transition');
});

test('phases and weekly labels follow session dates and interview preparation starts after required learning', () => {
  assert.deepEqual(data.planPhases.map(phase => phase.id), ['courses', 'career']);
  const covered = [];
  for (const phase of data.planPhases) {
    const weeks = data.weeks.filter(week => week.phaseId === phase.id);
    assert.equal(weeks.length, phase.endWeek - phase.startWeek + 1);
    assert.equal(weeks[0].start, phase.start);
    assert.equal(weeks.at(-1).end, phase.end, 'Phase boundaries delimit calendar reference weeks');
    if (phase.openEnded) assert.equal(phase.countLabel, '按进度推进', 'Reference weeks do not promise a workflow completion date');
    for (const [index, week] of weeks.entries()) {
      covered.push(week.week);
      assert.equal(week.phaseWeek, index + 1);
      const inWeek = allSessions.filter(session => week.start <= session.date && session.date <= week.end);
      assert.deepEqual(week.topics.map(topic => topic.track).sort(), [...new Set(inWeek.map(session => session.task.track))].sort());
      for (const topic of week.topics) assert.ok(topic.title?.trim());
      assert.ok(inWeek.every(session => phase.id === 'career' ? session.task.track === 'review' : session.task.track !== 'review'));
    }
  }
  assert.deepEqual(covered, data.weeks.map(week => week.week));
  const coursePhase = data.planPhases.find(phase => phase.id === 'courses');
  assert.equal(coursePhase.end, '2027-05-23');
  const lastLearning = learning.map(endDate).sort().at(-1);
  assert.ok(preparation.every(task => task.date > lastLearning));
  assert.equal(data.planRhythm.learningCompletionDate, lastLearning);
  const careerPhase = data.planPhases.find(phase => phase.id === 'career');
  assert.equal(careerPhase.startWeek, 34);
  assert.equal(careerPhase.endWeek, 36);
  assert.equal(careerPhase.start, '2027-05-24');
  assert.equal(careerPhase.openEnded, true);
  assert.equal(careerPhase.countLabel, '按进度推进');
  assert.equal(careerPhase.end, '2027-06-13');
  assert.equal(data.weeks.length, 36);
  assert.equal(tasks.length, 208);
  assert.equal(required.length, 207);
  assert.equal(learning.length, 184);
  assert.equal(workflow.preparationStartDate, '2027-05-24');
  assert.equal(workflow.preparationCompletionDate, preparation.map(endDate).sort().at(-1),
    'Workflow metadata follows the actual final material session');
});

test('the server curriculum contains the approved sources and covers every original second in forty-minute weekdays', () => {
  assert.equal(zeroVoice.length, 122);
  assert.equal(data.courseCatalog.length, 117);
  assert.deepEqual(data.courseCatalog.map(lesson => [lesson.sourceIndex, lesson.title, lesson.durationSeconds])
    .sort((a, b) => a[0] - b[0]), EXPECTED_ZERO_VOICE);
  assert.equal(sum(data.courseCatalog.map(lesson => lesson.durationSeconds)), 292533);
  assert.equal(zeroVoice[0].date, '2026-10-05');
  assert.equal(zeroVoice.at(-1).date, '2027-03-23');
  assert.equal(data.planRhythm.zeroVoiceCompletionDate, zeroVoice.at(-1).date);
  assert.deepEqual(zeroVoice.map(task => task.durationSeconds), [...Array(121).fill(2400), 2133]);
  const covered = new Map(), order = [];
  let previousDate = '';
  for (const task of zeroVoice) {
    assert.match(task.id, /^ls-module-v2-/);
    assert.equal(task.optional, undefined);
    assert.ok(weekday(task.date) >= 1 && weekday(task.date) <= 5);
    assert.ok(task.date > previousDate);
    previousDate = task.date;
    assert.equal(sum(task.learningSegments.map(segment => segment.endSecond - segment.startSecond)), task.durationSeconds);
    almostEqual(sum(task.segments.map(segment => segment.endMinute - segment.startMinute)), task.durationMinutes, 'Canonical minute ranges agree with exact-second footage');
    for (const segment of task.learningSegments) {
      const lesson = data.courseCatalog.find(item => item.id === segment.sectionId);
      assert.ok(lesson);
      assert.equal(segment.title, lesson.title);
      assert.equal(segment.totalSeconds, lesson.durationSeconds);
      assert.ok(Number.isInteger(segment.startSecond) && Number.isInteger(segment.endSecond));
      assert.equal(segment.startSecond, covered.get(segment.sectionId) || 0, 'No required footage is skipped or repeated');
      assert.ok(segment.endSecond > segment.startSecond && segment.endSecond <= segment.totalSeconds);
      if (!covered.has(segment.sectionId)) order.push(segment.sectionId);
      covered.set(segment.sectionId, segment.endSecond);
    }
  }
  assert.deepEqual(order, data.courseCatalog.map(lesson => lesson.id));
  for (const lesson of data.courseCatalog) assert.equal(covered.get(lesson.id), lesson.durationSeconds);
  assert.equal(sum([...covered.values()]), 292533);
  const sourceOrder = data.courseCatalog.map(lesson => lesson.sourceIndex);
  assert.ok(sourceOrder.indexOf(69) < sourceOrder.indexOf(135), 'Required encoding and newer FLV muxing precede the RTMP publisher implementation');
  assert.ok(sourceOrder.indexOf(158) < sourceOrder.indexOf(274), 'RTP/RTSP/RTCP precedes ZLM server source');
  assert.deepEqual(sourceOrder.filter(index => [271, 272, 273].includes(index)), [271, 273, 272], 'HLS lessons 154, 155, 156 follow their actual numbered order');
  const firstSrs = zeroVoice.find(task => task.learningSegments.some(segment => segment.sectionId === 'ls-source-253'));
  assert.equal(firstSrs.date, '2026-12-11');
  assert.ok(firstSrs.date < data.projectLearningScope.find(scope => scope.projectId === 'yunzhujiao').practiceCompletionDate);
  for (const task of tasks) assert.ok(!(task.prerequisiteTaskIds || []).some(id => id.startsWith('ls40-')));
  assert.ok(!data.courseCatalog.some(lesson => /4[.]2版本|ffplay|Android|MESH|P2P框架|C\+\+Native|WebRTC-peerconnection客户端/.test(lesson.title)));
  assert.ok(!tasks.some(task => task.optionalKind === 'version-reference'));
  assert.equal(data.courseCatalog.filter(lesson => /6[.]0版本/.test(lesson.title)).length, 1);
  assert.equal(data.courseCatalog.find(lesson => lesson.sourceIndex === 69).durationSeconds, 6977);
  const expectedModules = [
    ['media-api', [57, 58, 59, 60, 61, 62]],
    ['codec-flv', [63, 64, 65, 66, 67, 69]],
    ['studio-media', [70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83]],
    ['rtmp', [133, 134, 135, 136, 137]],
    ['hls-protocol', [138, 139, 140, 141, 142, 143, 146, 147]],
    ['srs-core', [253, 254, 255, 256, 257, 258, 259, 260, 261, 262]],
    ['srs-distribution', [263, 264, 265, 266, 267, 268, 269, 270, 271, 273, 272]],
    ['rtsp-rtp', [150, 151, 152, 153, 154, 155, 156, 157, 158]],
    ['zlm', [274, 275, 276, 277, 278, 279, 280, 281]],
    ['rtc-primer', [171, 172, 174, 175, 176, 177, 180, 181, 194, 195, 196, 197, 202, 203]],
    ['srs-rtc', [285, 286, 287, 288, 289, 290, 291, 292, 293, 294, 295, 296, 297, 298, 299, 300, 301, 302, 303, 304, 305, 307]],
    ['whip-whep', [355, 356, 357, 358]]
  ];
  assert.deepEqual(sourceOrder, expectedModules.flatMap(([, indices]) => indices),
    'Only whole modules move; retained lessons follow their original internal order except the corrected HLS numbering');
  const configured = data.zeroVoiceCurriculum;
  assert.deepEqual(configured.modules.map(module => [module.id, module.sourceIds]), expectedModules.map(([id, indices]) =>
    [id, indices.map(index => `ls-source-${String(index).padStart(3, '0')}`)]));
  assert.equal(configured.videoSeconds, 292533);
  assert.deepEqual(configured.modules.flatMap(module => module.sourceIds), order);
  for (const module of configured.modules) {
    const viewed = zeroVoice.filter(task => task.learningSegments.some(segment => module.sourceIds.includes(segment.sectionId)));
    assert.equal(module.startDate, viewed[0].date);
    assert.equal(module.endDate, viewed.at(-1).date);
    assert.equal(module.seconds, sum(data.courseCatalog.filter(lesson => module.sourceIds.includes(lesson.id)).map(lesson => lesson.durationSeconds)));
  }
});

test('all 156 former daily sessions and 207 split lessons retain exact independent historical snapshots', () => {
  const archived = new Map([...data.legacyVideoTasks, ...data.legacyReferenceTasks].map(task => [task.id, task]));
  const snapshots = ORIGINAL_SESSIONS.map(([id]) => archived.get(id));
  assert.ok(snapshots.every(Boolean));
  assert.deepEqual(snapshots.map(task => [task.id, task.date, task.durationMinutes, task.segments]), ORIGINAL_SESSIONS);
  assert.ok(snapshots.every(task => !byId.has(task.id)), 'Retired session records are never active assignments');
  const lessonIds = [...new Set(ORIGINAL_SESSIONS.flatMap(([, , , segments]) => segments.map(segment => segment.lessonId)))];
  const catalog = new Map(data.legacyCourseCatalog.map(lesson => [lesson.id, lesson]));
  assert.equal(catalog.size, 207);
  assert.equal(digest(lessonIds.map(id => catalog.get(id))), '82db5545c36de8ec53de28f2e24f24789282bc8477a95c3340c05c4448578b65',
    'The original split catalog remains a truthful snapshot, including the two superseded 4.2 entries');
  const retainedOriginal = ORIGINAL_SESSIONS.filter(([id]) => !RETIRED_FLV_IDS.has(id)).map(([id]) => archived.get(id));
  assert.equal(retainedOriginal.length, 154);
  for (const task of retainedOriginal) {
    const ranges = data.legacyZeroVoiceVideoRanges[task.id];
    assert.ok(ranges?.length, `${task.id}: retained source mapping supports exact progress migration`);
    for (const range of ranges) assert.ok(range.startSecond < range.endSecond && range.sourceStartSecond <= range.sourceEndSecond);
  }
  for (const id of RETIRED_FLV_IDS) assert.equal((data.legacyZeroVoiceVideoRanges[id] || []).length, 0, 'The old version cannot credit the newer video');
});

test('the preceding 122 server sessions retain their exact native ranges and never rewrite the earlier migration sources', () => {
  const preceding = data.legacyVideoTasks.filter(task => task.id.startsWith('ls-server-v1-'));
  assert.equal(data.legacyVideoTasks.length, 322);
  assert.equal(preceding.length, 122);
  assert.equal(digest(preceding), 'd75f64558a172475ff05d7616688bffc3dd6651cee168d0115d2866ac8b6acd7',
    'The complete prior task objects preserve their dates, titles, ranges, budgets and historical links');
  assert.ok(preceding.every(task => !byId.has(task.id)), 'Earlier native tasks remain archive sources rather than active duplicates');
  assert.deepEqual(Object.keys(data.legacyZeroVoiceVideoGenerations).sort(), preceding.map(task => task.id).sort());
  assert.ok(Object.values(data.legacyZeroVoiceVideoGenerations).every(generation => generation === 2));
  assert.equal(digest(data.legacyZeroVoiceVideoRanges), '7f7be3b8bbaa86c3092e0a95e47eb2c147b735ef09fa1db73ab9d1df68cd5f4d',
    'Reordering modules leaves all 154 earliest raw-stop mappings unchanged');
});

test('module reordering preserves every non-Zero-Voice task, date, source scope and teacher workflow', () => {
  const nonLs = tasks.filter(task => task.track !== 'ls').map(task => Object.fromEntries(Object.entries(task)
    .filter(([key]) => key !== 'prerequisiteTaskIds')));
  assert.equal(digest(nonLs), '824ef9fa6cc5b65122db426a73d5b0f89f8b525563705727179a4af59d6e2df4',
    'Only current Zero Voice prerequisite IDs may change outside the reordered curriculum');
  assert.equal(digest(data.projectLearningScope), 'df0454ce62eac36110408737f5ac41f0a64d3c6e1950c1cc9e0d1ce252f94e0b');
  assert.equal(digest(data.careerWorkflow), 'dc8d6ad263a0f98ae0098392f6d199a0e31416aba85ec127c38495062f8dbd13');
  for (const task of tasks) assert.ok(!(task.prerequisiteTaskIds || []).some(id => id.startsWith('ls-server-v1-')),
    'Archived native session IDs cannot remain current learning prerequisites');
});

test('all 165 Edoyun videos retain their catalog order, exact seconds and original viewing dates', () => {
  assert.equal(expectedSections.size, 165);
  assert.equal(videos.length, 27);
  assert.equal(digest(videos.map(task => [task.id, task.date, task.durationMinutes, task.learningSegments])),
    'a2dda6b8a3983f81d8b518c73306482a1d495c8b8c110d48b9a057b180c06354',
    'The genuine original video sessions keep every ID, date, duration and exact playback interval');
  const covered = new Map(), order = [];
  for (const task of videos) {
    assert.equal(task.track, 'ydy');
    assert.equal(task.activity, 'video');
    assert.equal(weekday(task.date), 6);
    for (const segment of task.learningSegments) {
      const reference = expectedSections.get(String(segment.sectionId));
      assert.ok(reference);
      assert.equal(segment.courseTitle, reference.course.title);
      assert.equal(segment.totalSeconds, reference.seconds);
      assert.ok(task.week >= reference.course.firstWeek && task.week <= reference.course.lastWeek);
      assert.ok(segment.title?.trim() && segment.chapterTitle?.trim());
      assert.ok(Number.isInteger(segment.startSecond) && Number.isInteger(segment.endSecond));
      assert.equal(segment.startSecond, covered.get(String(segment.sectionId)) || 0);
      assert.ok(segment.endSecond > segment.startSecond && segment.endSecond <= reference.seconds);
      if (!covered.has(String(segment.sectionId))) order.push(String(segment.sectionId));
      covered.set(String(segment.sectionId), segment.endSecond);
    }
  }
  assert.deepEqual(order, [...expectedSections.keys()]);
  for (const [id, reference] of expectedSections) assert.equal(covered.get(id), reference.seconds);
  assert.equal(sum([...covered.values()]), 303529);
  assert.deepEqual(data.projectLearningScope.map(scope => [scope.projectId, scope.startWeek, scope.endWeek, scope.videoCompletionDate]), [
    ['yibo', 1, 6, '2026-11-14'], ['yunzhujiao', 9, 17, '2027-01-30'], ['studio-course', 20, 31, '2027-05-08']
  ]);
  assert.equal(data.planRhythm.edoyunVideoCompletionDate, '2027-05-08');
  assert.deepEqual(videos.filter(task => task.projectId === 'yibo').map(task => task.date),
    ['2026-10-10', '2026-10-17', '2026-10-24', '2026-10-31', '2026-11-07', '2026-11-14']);
});

test('course practice covers every original section with complete modules and honest integer estimates', () => {
  assert.equal(practice.length, 35);
  assert.equal(digest(practice.map(curriculumContent)), '9e8089016022a53cf4d315b43c754dbf667eb062f2ed8b493e96366448dc9d69',
    'All 35 practice modules retain their content, duration, source sections, estimates and outputs while their sessions move');
  const covered = new Set();
  const finalVideoBySection = new Map();
  for (const task of videos) for (const section of task.learningSegments)
    if (section.endSecond === section.totalSeconds) finalVideoBySection.set(String(section.sectionId), task);
  for (const task of practice) {
    assert.ok(Number.isInteger(task.durationMinutes) && task.durationMinutes % 30 === 0,
      'Practice uses task-based half-hour estimates rather than second-precise residual video budgets');
    assert.ok(task.estimateBasis?.trim() && /初估|estimate/.test(task.estimateKind || task.estimateBasis));
    assert.ok(!task.practiceParts?.length, 'New modules do not inherit arbitrary equal thirds of retired practice');
    assert.ok(task.sourceSectionIds.length && task.sourceSections.length);
    assert.deepEqual(task.sourceSectionIds, task.sourceSections.map(section => section.sectionId));
    for (const section of task.sourceSections) {
      const id = String(section.sectionId), video = finalVideoBySection.get(id);
      assert.ok(expectedSections.has(id));
      covered.add(id);
      assert.ok(video && task.date >= video.date, `${task.id}: practice cannot precede its fully viewed section`);
      assert.equal(section.videoCompletionDate, video.date);
      assert.equal(section.videoTaskId, video.id);
      assert.ok(ancestors(task).has(video.id), `${task.id}: source viewing is a real prerequisite`);
    }
    assert.ok(task.steps.length >= 2 && task.deliverables.length);
    assert.ok(task.workSessions.length);
  }
  assert.deepEqual([...covered].sort(), [...expectedSections.keys()].sort());
  assert.ok(practice.some(task => task.workSessions.length > 1), 'A module can continue across sessions without duplicating its output requirement');
});

test('Yibo practice includes both database adapters, the actual business path and final project validation', () => {
  const text = suffix => {
    const task = byId.get(`edoyun-module-v1-yibo-${suffix}`);
    assert.ok(task);
    return [...task.steps, ...task.deliverables].join(' ');
  };
  assert.match(text('sqlite'), /SQLite.*持久化|持久化.*SQLite/);
  assert.match(text('mysql'), /MySQL.*读写/);
  assert.match(text('business'), /HTTP.*数据库.*加密/);
  assert.match(text('business'), /同一次请求|属于同一次/);
  assert.match(text('selftest'), /完整Linux服务|完整.*服务/);
  assert.match(text('selftest'), /干净目录.*55节/);
  assert.match(text('selftest'), /核心功能未通过.*阻塞/);
});

test('Cloud practice requires audio and video end to end, real load allocation and an executed remote command', () => {
  const text = suffix => {
    const task = byId.get(`edoyun-module-v1-yunzhujiao-${suffix}`);
    assert.ok(task);
    return [...task.steps, ...task.deliverables].join(' ');
  };
  assert.match(text('environment-codecs'), /视频编码\/解码.*音频编码\/解码/);
  assert.match(text('load-balancer'), /两个节点.*不可用节点/);
  assert.match(text('client-push-pull'), /音频和视频解码\/渲染/);
  assert.match(text('client-push-pull'), /既有声音又有画面/);
  assert.match(text('remote-managers'), /发送端.*信令.*目标客户端.*实际状态变化或回执/);
  assert.match(text('package-selftest'), /登录→负载分配→音视频推流→拉流播放→一条远程指令→停止退出/);
});

test('Studio practice proves the original visible features and keeps hardware or external-service limits truthful', () => {
  const text = suffix => {
    const task = byId.get(`edoyun-module-v1-studio-course-${suffix}`);
    assert.ok(task);
    return [...task.steps, ...task.deliverables].join(' ');
  };
  assert.match(text('environment-qt'), /Windows.*阻塞/);
  assert.match(text('winrt-camera'), /实际获取连续画面/);
  assert.match(text('wasapi-buffer'), /麦克风.*系统回环/);
  assert.match(text('mix-sync'), /双路混音|两路.*混音/);
  assert.match(text('yunet-effects'), /人脸\/无人脸.*YuNet/);
  assert.match(text('yunet-effects'), /可见.*特效|特效开关对照/);
  assert.match(text('scene-editing'), /至少两个真实源.*Z序/);
  assert.match(text('scene-editing'), /JSON.*关闭重开/);
  assert.match(text('ai-hook'), /关闭\/重新启用Hook/);
  assert.match(text('cuda-compare'), /CPU功能.*CUDA不可测/);
  assert.match(text('selftest-handoff'), /采集→混音\/转换→编码→直播与录制→文件完整解码/);
  assert.match(text('selftest-handoff'), /未验证云同步\/CUDA优化/);
});

test('each practice output belongs to its full module instead of being copied into a preparation-only slice', () => {
  const outputs = new Map();
  for (const task of practice) for (const output of task.deliverables) {
    assert.ok(!outputs.has(output), `${task.id}: a second task cannot require the same full-module output`);
    outputs.set(output, task.id);
  }
  const cloud = byId.get('edoyun-module-v1-yunzhujiao-environment-codecs');
  assert.match(cloud.steps.join(' '), /编.*解码|编码\/解码/);
  assert.match(cloud.deliverables.join(' '), /编解码结果/);
  const cuda = byId.get('edoyun-module-v1-studio-course-cuda-compare');
  assert.match(cuda.steps.join(' '), /实际跑通CPU功能/);
  assert.match(cuda.deliverables.join(' '), /CPU可运行结果/);
  assert.ok(!tasks.some(task => /^ydy-practice-v[234]-/.test(task.id)), 'Retired partial-module slices are history only');
});

test('Edoyun projects stay strictly serial through their final required practice and acceptance', () => {
  const ordered = ['yibo', 'yunzhujiao', 'studio-course'];
  for (let index = 1; index < ordered.length; index++) {
    const previous = required.filter(task => task.projectId === ordered[index - 1]);
    const next = required.filter(task => task.projectId === ordered[index]);
    const finalDate = previous.map(endDate).sort().at(-1);
    assert.ok(next.every(task => task.date > finalDate), 'No course project begins before prior project sessions finish');
    for (const task of next) {
      const needed = ancestors(task);
      for (const prerequisite of previous)
        assert.ok(needed.has(prerequisite.id), `${task.id}: actual previous project completion is required`);
    }
  }
  const finalCourse = byId.get('edoyun-module-v1-studio-course-selftest-handoff');
  assert.ok(endDate(finalCourse) <= '2027-05-31');
  assert.equal(endDate(finalCourse), data.planRhythm.courseWrapUpDate);
  assert.equal(endDate(finalCourse), data.planRhythm.practiceCompletionDate);
  assert.equal(data.planRhythm.courseAccessDeadline, '2027-06-07');
  const firstStudio = practice.find(task => task.projectId === 'studio-course');
  assert.equal(firstStudio.date, '2027-02-20');
});

test('the teacher workflow consumes the original course work without replacement polishing gates', () => {
  assert.ok(!tasks.some(task => task.phaseId === 'projects' || task.activity === 'portfolio'
    || task.activity === 'deepening' || task.id.startsWith('studio-portfolio-v1-')));
  assert.ok(!data.milestones.some(goal => ['studio-portfolio', 'studio-rtc', 'studio-validation', 'studio-baseline'].includes(goal.id)));
  assert.equal(Object.hasOwn(data, 'portfolioScope'), false);
  for (const key of ['portfolioMinutes', 'deepeningMinutes', 'deepeningRangeMinutes'])
    assert.equal(Object.hasOwn(data.estimationPolicy, key), false);
  for (const key of ['projectStartDate', 'projectEndDate'])
    assert.equal(Object.hasOwn(data.planRhythm, key), false);
  assert.equal(data.estimationPolicy.onDemandReserveMinutes, 300);
  assert.equal(data.estimationPolicy.optionalExtensionsScheduledMinutes, 0);
  const gate = byId.get('edoyun-module-v1-studio-course-selftest-handoff');
  assert.ok(ancestors(preparation[0]).has(gate.id));
  for (const task of reviews) {
    assert.ok(ancestors(task).has(gate.id));
    assert.ok([...ancestors(task)].every(id => !id.startsWith('studio-portfolio-v1-') && !id.startsWith('studio-functional-v1-')));
  }
  const retiredGoals = data.legacyMilestones.filter(goal => ['studio-rtc', 'studio-validation'].includes(goal.id));
  assert.equal(digest(retiredGoals), '2b02bc2cddcfa4aaf2dd2cd3667f4b8d274503e0677eb902e10695b033a19339');
  const retiredPortfolio = data.legacyMilestones.find(goal => goal.id === 'studio-portfolio');
  assert.equal(digest(retiredPortfolio), '904d58dbaff96688370a1e85d12af39f0c386b7b75beecc2afba295cdd5f4b11',
    'An acceptance for the removed independent scope is preserved as history, not inherited by the course self-test');
});

test('larger extensions are reference material without tasks, budgets or completion gates', () => {
  assert.ok(Array.isArray(data.optionalExtensions) && data.optionalExtensions.length > 0);
  for (const item of data.optionalExtensions) {
    assert.ok(item.title?.trim() || typeof item === 'string' && item.trim());
    assert.ok(!item.id || !byId.has(item.id));
    for (const key of ['durationMinutes', 'budget', 'workSessions', 'taskIds', 'date', 'startDate', 'endDate', 'prerequisiteTaskIds'])
      assert.equal(Object.hasOwn(item, key), false, `${key}: optional reading cannot inflate the fixed curriculum`);
  }
  const descriptions = data.optionalExtensions.map(item => typeof item === 'string' ? item : JSON.stringify(item)).join(' ');
  assert.match(descriptions, /WebRTC|TURN|MESH|SFU/);
  assert.match(descriptions, /ABR|弱网|负载|并发/);
  const laterPortfolio = data.optionalExtensions.find(item => item.id === 'studio-portfolio-later');
  assert.ok(laterPortfolio, 'Canceled polishing is available as read-only reference, with no current tasks');
  for (const key of ['record-index', 'playback', 'diagnose', 'delivery'])
    assert.ok(laterPortfolio.historicalTaskIds.includes(`studio-portfolio-v1-${key}`));
  assert.ok(laterPortfolio.historicalReviewKeys.includes('milestone:portfolio-v1-studio-portfolio'));
});

test('optional remediation is an on-demand pool and never becomes an unconditional learning or career prerequisite', () => {
  const optional = tasks.filter(task => task.optional === true);
  assert.equal(optional.length, 1);
  const remediation = optional;
  assert.equal(remediation.length, 1);
  assert.equal(remediation[0].phaseId, 'courses');
  for (const task of remediation) {
    assert.equal(task.onDemand, true);
    assert.equal(sessions(task).length, 0, 'Optional repair is not booked on top of an already full project Saturday');
    assert.ok(task.durationMinutes > 0 && Number.isInteger(task.durationMinutes));
    assert.match([...task.steps, ...task.deliverables].join(' '), /无需|没有缺口|无缺陷|无需补漏/);
  }
  for (const task of required) for (const id of ancestors(task))
    assert.notEqual(byId.get(id).optional, true, `${task.id}: an unused optional pool cannot block completion`);
});

test('complete project and weekend skill modules precede an undated zero-hour teacher confirmation and fifteen relative interview tasks', () => {
  assert.equal(reviews.length, 23);
  assert.equal(preparation.length, 7);
  assert.ok(preparation.every(task => task && task.optional !== true && Number.isInteger(task.durationMinutes)));
  assert.equal(sum(preparation.map(task => task.durationMinutes)), 800);
  assert.equal(digest(preparation.map(curriculumContent)), 'ff91d97a7d22cc0b761cd2470fa0fd1093738d2645502b546c336e66fc745826',
    'All seven material modules retain content and complete budgets while calendar sessions move');
  assert.deepEqual(workflow.projectPreparationTaskIds, ['remote', 'yibo', 'cloud', 'studio'].map(key => `career-materials-v2-${key}`));
  assert.deepEqual(workflow.skillPreparationTaskIds, ['av', 'build', 'cpp'].map(key => `career-materials-v2-skills-${key}`));
  assert.deepEqual([...workflow.preparationTaskIds].sort(), [...workflow.projectPreparationTaskIds, ...workflow.skillPreparationTaskIds].sort());
  assert.equal(teacher.id, 'career-teacher-v1-confirmation');
  assert.equal(teacher.scheduleKind, 'external');
  assert.equal(teacher.activity, 'external-confirmation');
  assert.equal(teacher.durationMinutes, 0);
  assert.deepEqual(teacher.budget, { videoMinutes: 0, practiceMinutes: 0, bufferMinutes: 0 });
  assert.match([...teacher.steps, ...teacher.deliverables].join(' '), /老师|教师|导师/);
  for (const task of preparation) assert.ok(ancestors(teacher).has(task.id));
  assert.equal(interviews.length, 15);
  assert.equal(digest(interviews), 'd92b025cbf35362b6a8a42cf28947bbca3763a9e29fd35417bbdf3dd11829ce3', 'All fifteen interview objects remain unchanged');
  assert.deepEqual(interviews.map(task => task.relativeOrder), Array.from({ length: 15 }, (_, index) => index + 1));
  for (const task of [teacher, ...interviews]) {
    for (const key of ['date', 'day', 'startDate', 'endDate']) assert.equal(Object.hasOwn(task, key), false);
    assert.deepEqual(task.workSessions, []);
    assert.equal(sessions(task).length, 0, 'Waiting and relative work have no made-up fixed calendar slots');
    assert.equal(task.week, 36, 'The outline has a home without implying a dated session');
  }
  for (const task of interviews) {
    assert.equal(task.scheduleKind, 'after-event');
    assert.equal(task.anchorTaskId, teacher.id);
    assert.equal(task.durationMinutes, 40);
    assert.ok(ancestors(task).has(teacher.id), 'Advance completion cannot erase the real teacher-confirmation prerequisite');
  }
  const unchangedInterviews = interviews.filter(task => !['career-teacher-v1-feedback', 'career-teacher-v1-remote-interview'].includes(task.id));
  assert.equal(unchangedInterviews.length, 13);
  const scheduleFields = new Set(['date', 'startDate', 'endDate', 'week', 'day', 'workSessions', 'duration', 'summary',
    'prerequisiteTaskIds', 'scheduleKind', 'anchorTaskId', 'relativeOrder']);
  assert.equal(digest(unchangedInterviews.map(task => Object.fromEntries(Object.entries(task)
    .filter(([key]) => !scheduleFields.has(key))))),
  'fbb1aa1bf0cfba57304280a25662b8a889e03dce05931cd0101d870821ab86b6',
  'The thirteen original technical topics keep their content rather than inheriting newly required project work');
  assert.equal(digest(interviews.map(task => Object.fromEntries(Object.entries(task).filter(([key]) => key !== 'week')))),
    '2a781281b74ae6323485141e430e0c084d545335443b83afd8a4b2ac850d03e3', 'All fifteen original interview task objects change only their outline week');
  const feedback = byId.get('career-teacher-v1-feedback');
  assert.equal(interviews.at(-1).id, feedback.id);
  assert.match([...feedback.steps, ...feedback.deliverables].join(' '), /老师|教师|导师/);
  const careerSessions = allSessions.filter(session => session.task.track === 'review');
  assert.equal(careerSessions.length, 17);
  assert.equal(sum(careerSessions.map(session => session.minutes)), 800);
  assert.equal(sum(reviews.map(task => task.durationMinutes)), 1400);
  for (const task of reviews) for (const prerequisite of learning)
    assert.ok(ancestors(task).has(prerequisite.id), `${task.id}: actual original learning still precedes the career workflow`);
  assert.deepEqual(data.applicationMilestone.readinessTaskIds, [...workflow.preparationTaskIds, teacher.id]);
  assert.ok(!data.applicationMilestone.start && !data.applicationMilestone.end);
  assert.match(data.applicationMilestone.timingLabel, /实际|确认|简历/);
  for (const key of ['interviewStartDate', 'interviewCompletionDate', 'planEndDate'])
    assert.equal(Object.hasOwn(data.planRhythm, key), false, 'External delivery cannot be assigned a guaranteed date');
});

test('the already completed remote-control project is prepared for career discussion without being scheduled for relearning', () => {
  assert.equal(digest(data.completedProjects), '525d40f5e5bdbc638cf947f83bf4fada2083282c48c34829b6046fee5e94f631',
    'The original remote-control completion acknowledgement keeps its truthful dates');
  const remoteMaterials = byId.get('career-materials-v2-remote');
  const remoteInterview = byId.get('career-teacher-v1-remote-interview');
  assert.ok(remoteMaterials && remoteInterview);
  assert.equal(workflow.preparationTaskIds[0], remoteMaterials.id);
  assert.equal(workflow.interviewTaskIds[4], remoteInterview.id);
  assert.equal(remoteInterview.relativeOrder, 5);
  assert.equal(remoteMaterials.durationMinutes, 160);
  assert.equal(remoteInterview.durationMinutes, 40);
  for (const task of [remoteMaterials, remoteInterview]) {
    assert.equal(task.track, 'review');
    assert.ok(!task.learningSegments?.length && !task.segments?.length);
    assert.match([task.title, task.summary, ...task.steps, ...task.deliverables].join(' '), /远控/);
    assert.match([task.summary, ...task.steps].join(' '), /已完成|已有|回顾|复用/);
  }
  assert.equal(learning.length, 184);
  assert.ok(learning.filter(task => task.track === 'ydy')
    .every(task => ['yibo', 'yunzhujiao', 'studio-course'].includes(task.projectId)));
  const teacherText = [...teacher.steps, ...teacher.deliverables].join(' ');
  for (const name of ['远控', '易播', '云助教', 'Course Studio'])
    assert.ok(teacherText.includes(name), `The teacher discussion includes ${name}`);
  assert.match(teacherText, /材料|入口|汇总/);
  assert.match(teacherText, /问题|提问|沟通/);
  assert.ok(!byId.has('career-teacher-v1-brief'), 'The old short brief is history rather than an extra current task');
  assert.ok(ancestors(teacher).has(remoteMaterials.id));
  assert.ok(ancestors(remoteInterview).has(teacher.id));
});

test('four project modules use fourteen serial forty-minute weekdays while three skill modules run independently on Saturday', () => {
  const expected = [
    ['remote', 160, '2027-05-24', '2027-05-27'],
    ['yibo', 80, '2027-05-28', '2027-05-31'],
    ['cloud', 200, '2027-06-01', '2027-06-07'],
    ['studio', 120, '2027-06-08', '2027-06-10']
  ];
  const projectModules = workflow.projectPreparationTaskIds.map(id => byId.get(id));
  const skills = workflow.skillPreparationTaskIds.map(id => byId.get(id));
  for (const [index, [key, minutes, start, end]] of expected.entries()) {
    const task = byId.get(`career-materials-v2-${key}`);
    assert.equal(task.durationMinutes, minutes);
    assert.equal(task.date, start);
    assert.equal(endDate(task), end);
    assert.equal(task.workSessions.length, minutes / 40);
    assert.ok(task.workSessions.every(session => session.minutes === 40 && weekday(session.date) > 0 && weekday(session.date) < 6));
    assert.ok(task.steps.length >= 2 && task.deliverables.length);
    assert.equal(tasks.filter(item => item.id === task.id).length, 1);
    if (index) {
      const previous = projectModules[index - 1];
      assert.ok(ancestors(task).has(previous.id));
      assert.ok(endDate(previous) < task.date);
    }
    for (const skill of skills) assert.ok(!ancestors(task).has(skill.id), 'Weekend skill learning cannot block the weekday project sequence');
  }
  assert.equal(sum(projectModules.flatMap(task => task.workSessions).map(session => session.minutes)), 14 * 40);
  assert.deepEqual(skills.map(task => [task.durationMinutes, task.date]), [[120, '2027-05-29'], [60, '2027-06-05'], [60, '2027-06-05']]);
  for (const task of skills) {
    assert.ok(task.workSessions.every(session => weekday(session.date) === 6));
    for (const project of projectModules) assert.ok(!ancestors(task).has(project.id), 'Skills remain available even while a long project module is unfinished');
    assert.ok(ancestors(teacher).has(task.id));
  }
  assert.match([...skills[0].steps, ...skills[0].deliverables].join(' '), /音视频|编码|采集|同步/);
  assert.match([...skills[1].steps, ...skills[1].deliverables].join(' '), /CMake/);
  assert.match([...skills[1].steps, ...skills[1].deliverables].join(' '), /Makefile|Make/);
  assert.match([...skills[2].steps, ...skills[2].deliverables].join(' '), /C\+\+17/);
});

test('retired residual-budget tasks keep exact historical metadata without remaining current assignments', () => {
  const references = data.legacyReferenceTasks;
  const original14Ids = new Set([
    ...[32, 33, 34].flatMap(week => [2, 3, 4].map(day => `av52-may-v1-w${week}-${day}-course-practice`)),
    ...['2-project', '3-project', '4-project', '5-build', '5-verify'].map(suffix => `av52-may-v1-w46-${suffix}`)
  ]);
  const old14 = references.filter(task => original14Ids.has(task.id));
  assert.equal(old14.length, 14);
  assert.equal(digest(old14), '903a1c096fb3c79269b9b37fbd1cea4dd109a4d448f11267b7446f00ec3fe313');
  const oldFunctional = references.filter(task => task.id.startsWith('studio-functional-v1-') && task.optional !== true).sort((a, b) => a.id.localeCompare(b.id));
  assert.equal(oldFunctional.length, 11);
  assert.equal(digest(oldFunctional), '311a48859b633b9148c6b11070d247b66aa81cea54454a516caaec8e0032c042',
    'The retired 90-hour design remains exact history rather than a current learning gate');
  const retiredPortfolio = references.filter(task => task.id.startsWith('studio-portfolio-v1-')
    || task.id === 'studio-functional-v1-optional-remediation').sort((a, b) => a.id.localeCompare(b.id));
  assert.equal(retiredPortfolio.length, 5);
  assert.equal(digest(retiredPortfolio), 'df7aef3108249590dd5f376dc5afdc52acc8d394f539a6611b71db51f43ee8c3',
    'Canceled polishing modules and their optional pool retain their full original metadata');
  const retiredCareerIds = new Set(['target', 'evidence', 'resume', 'demo', 'resume-revision'].map(key => `career-focused-v1-${key}`));
  const retiredCareer = references.filter(task => retiredCareerIds.has(task.id)).sort((a, b) => a.id.localeCompare(b.id));
  assert.equal(retiredCareer.length, 5);
  assert.equal(digest(retiredCareer), '75da3a566461750fa45947b18762dfe488ce7bde95b262a50b21598794c2e693',
    'Old self-written resume steps remain exact history rather than completed teacher collaboration');
  const retiredPreparationIds = new Set(['remote-materials', 'yibo-materials', 'cloud-materials', 'studio-materials', 'skills', 'brief']
    .map(key => `career-teacher-v1-${key}`));
  const retiredPreparation = references.filter(task => retiredPreparationIds.has(task.id)).sort((a, b) => a.id.localeCompare(b.id));
  assert.equal(retiredPreparation.length, 6);
  assert.equal(digest(retiredPreparation), 'a23b23af5b585c9ce34a1842dfb1e361c8333df96a211737d0176458dc4bda4d',
    'The superseded short material check-ins keep their full original dates, estimates, content and references');
  assert.equal(references.length, 212);
  const retiredVersions = references.filter(task => RETIRED_FLV_IDS.has(task.id));
  assert.equal(retiredVersions.length, 2);
  assert.equal(digest(retiredVersions), '52b94a5cb7862ddd9843a0299851d5ad55a0bb332a74436fddc98eac52bbcbed',
    'Retired versions retain the exact old task definitions for saved-record lookup');
  const earlierReferences = references.filter(task => !RETIRED_FLV_IDS.has(task.id));
  assert.equal(digest(earlierReferences), '15febc5da238df4719501ccc36bc21d4349f7c4f971efe648c4f9890f239970f', 'Removing versions never rewrites earlier archives');
  assert.equal(digest(earlierReferences.filter(task => !retiredPreparationIds.has(task.id))),
    'ee6354ad5998e8cfdc42d904edb98370d63ceafc506cce43ecc1d872bb93fe90', 'The earlier 204 historical tasks remain unchanged');
  const retiredPortfolioIds = new Set(retiredPortfolio.map(task => task.id));
  const oldFunctionalIds = new Set(oldFunctional.map(task => task.id));
  const retired = earlierReferences.filter(task => !original14Ids.has(task.id) && !oldFunctionalIds.has(task.id) && !retiredPortfolioIds.has(task.id) && !retiredCareerIds.has(task.id) && !retiredPreparationIds.has(task.id)).sort((a, b) => a.id.localeCompare(b.id));
  assert.equal(retired.length, 169);
  assert.equal(digest(retired), 'b176ebb9fa8c71c0bf30e94295f3a543333b2b678fd59a17126519ef9575581b',
    'Earlier titles, steps, dates, budgets and dependencies remain truthful historical snapshots');
  assert.ok(references.every(task => !byId.has(task.id)));
  assert.equal(new Set(references.map(task => task.id)).size, references.length);
  assert.equal(digest(data.legacyVideoTasks.filter(task => task.track !== 'ls')), 'c65bbee716427fca93a8b0ae36739df66ba828c5a2f68396c2667049575c1eee');
  assert.equal(digest(data.legacyPracticeTasks), '7ff6ad7b5dcfdf019de8501b416736c3b0db60b472e7c102632165817a54b1db');
  const archives = new Set([...references, ...data.legacyPracticeTasks, ...data.legacyVideoTasks].map(task => task.id));
  for (const task of tasks) for (const id of task.historicalTaskIds || [])
    assert.ok(archives.has(id), `${task.id}: historical reference resolves`);
});

test('all task budgets and session-based prerequisite boundaries are internally consistent', () => {
  const order = new Map(tasks.map((task, index) => [task.id, index]));
  for (const task of tasks) {
    assert.ok(task.activity?.trim() && task.summary?.trim());
    assert.ok(task.budget && ['videoMinutes', 'practiceMinutes', 'bufferMinutes'].every(key => Number.isFinite(task.budget[key]) && task.budget[key] >= 0));
    almostEqual(sum(Object.values(task.budget)), task.durationMinutes, `${task.id}: budget matches total estimate`);
    const genuineVideo = task.learningSegments?.length ? sum(task.learningSegments.map(segment => (segment.endSecond - segment.startSecond) / 60))
      : sum((task.segments || []).map(segment => segment.endMinute - segment.startMinute));
    almostEqual(task.budget.videoMinutes, genuineVideo, `${task.id}: estimates cannot masquerade as course footage`);
    if (task.track !== 'ls') {
      assert.ok(task.steps?.length && task.deliverables?.length);
      assert.ok(task.steps.every(step => typeof step === 'string' && step.trim()));
      assert.ok(task.deliverables.every(item => typeof item === 'string' && item.trim()));
    }
    ancestors(task);
    for (const id of task.prerequisiteTaskIds || []) {
      const parent = byId.get(id);
      if (task.date && endDate(parent)) assert.ok(endDate(parent) <= task.date, `${task.id}: prerequisite sessions finish before dependent work begins`);
      assert.ok(order.get(id) < order.get(task.id), 'Same-day prerequisites precede consumers in the display order');
    }
  }
});

test('milestones own current modules once and use the last required session as their delivery date', () => {
  const assigned = [], requiredAssigned = [], optionalAssigned = [];
  assert.equal(new Set(data.milestones.map(goal => goal.id)).size, data.milestones.length);
  for (const goal of data.milestones) {
    assert.ok(goal.taskIds?.length, `${goal.id}: retired empty baseline milestones are removed`);
    const owned = goal.taskIds.map(id => byId.get(id));
    assert.ok(owned.every(Boolean));
    assert.ok(owned.every(task => task.goalId === goal.id));
    const requiredOwned = owned.filter(task => task.optional !== true);
    if (requiredOwned.some(task => ['external', 'after-event'].includes(task.scheduleKind)))
      assert.ok(!goal.date, 'The career milestone follows actual collaboration instead of the last dated preparation session');
    else if (requiredOwned.length) assert.equal(goal.date, requiredOwned.map(endDate).sort().at(-1));
    assigned.push(...goal.taskIds);
    requiredAssigned.push(...requiredOwned.map(task => task.id));
    optionalAssigned.push(...owned.filter(task => task.optional === true).map(task => task.id));
  }
  assert.equal(new Set(assigned).size, assigned.length);
  assert.deepEqual(requiredAssigned.slice().sort(), required.map(task => task.id).sort());
  assert.deepEqual(optionalAssigned, [], 'On-demand repair pools stay separate from fixed milestone work');
  const courses = data.milestones.find(goal => goal.id === 'courses');
  assert.equal(courses.taskIds.length, 122);
  assert.equal(courses.taskIds.filter(id => byId.get(id).optional !== true).length, 122);
  assert.ok(tasks.filter(task => task.optional === true).every(task => data.milestones.some(goal => goal.id === task.goalId)),
    'On-demand pools retain a visible project owner without entering its required count');
});
