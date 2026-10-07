'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

// Independent snapshots of the existing 156 sessions and the three public catalogs.
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
    title: "易播加密播放器Linux服务端", firstWeek: 1, lastWeek: 10,
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
    title: "云助教", firstWeek: 11, lastWeek: 24,
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
    title: "Course Studio", firstWeek: 25, lastWeek: 33,
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

const html = fs.readFileSync(path.resolve(__dirname, '..', 'study-tracker.html'), 'utf8');
const embedded = html.match(/\bconst DATA\s*=\s*(\{[\s\S]*?\})\s*;\s*<\/script>/);
assert.ok(embedded, 'The delivered HTML must contain the complete schedule data');
const data = JSON.parse(embedded[1]);
const tasks = data.weeks.flatMap(week => week.tasks);
const sum = values => values.reduce((total, value) => total + value, 0);
const almostEqual = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-7, `${message}: ${actual} != ${expected}`);
const isoDate = instant => new Date(instant).toISOString().slice(0, 10);
const weekday = date => new Date(`${date}T12:00:00Z`).getUTCDay();

test('the complete calendar switches from lessons to interviews and projects while preserving daily limits', () => {
  assert.equal(data.weeks.length, 52);
  assert.equal(data.weeks[0].start, '2026-10-05');
  assert.equal(data.weeks.at(-1).end, '2027-10-03');
  assert.equal(data.planRhythm.weekdayVideoMinutes, 40);
  assert.equal(data.planRhythm.weekdayPracticeMinutes, 0);
  assert.equal(data.planRhythm.saturdayMinutes, 300);
  assert.equal(data.planRhythm.sundayOptional, true);
  assert.equal(tasks.length, 364);
  assert.equal(new Set(tasks.map(task => task.id)).size, tasks.length, 'Task IDs cannot collide');
  const topics = data.weeks.map(week => week.topic?.trim());
  assert.ok(topics.every(Boolean));
  assert.equal(new Set(topics).size, data.weeks.length, 'Every week needs a distinct, useful topic');
  data.weeks.forEach((week, index) => {
    assert.equal(week.week, index + 1);
    assert.equal(week.start, isoDate(Date.parse('2026-10-05T00:00:00Z') + index * 7 * 86400000));
    assert.equal(week.end, isoDate(Date.parse(`${week.start}T00:00:00Z`) + 6 * 86400000));
    const dayTotals = new Map();
    for (const task of week.tasks) {
      assert.equal(task.week, week.week);
      assert.ok(task.date >= week.start && task.date <= week.end, `${task.id}: date belongs to its week`);
      assert.ok(Number.isFinite(task.durationMinutes) && task.durationMinutes > 0);
      dayTotals.set(task.date, (dayTotals.get(task.date) || 0) + task.durationMinutes);
      assert.notEqual(weekday(task.date), 0, `${task.id}: Sundays have no fixed assignments`);
      if (weekday(task.date) === 6) assert.equal(task.track, 'ydy', 'Saturday is reserved for Edoyun and projects');
      if (task.track === 'ls') assert.ok(weekday(task.date) >= 1 && weekday(task.date) <= 5);
    }
    for (let offset = 0; offset < 5; offset++) {
      const date = isoDate(Date.parse(`${week.start}T00:00:00Z`) + offset * 86400000);
      const dayTasks = week.tasks.filter(task => task.date === date);
      assert.equal(dayTasks.length, 1, `${date}: one weekday assignment, without extra practice`);
      const task = dayTasks[0];
      assert.ok(task.durationMinutes >= 35 && task.durationMinutes <= 45, `${date}: the only task remains about 40 minutes`);
      assert.equal(task.learningSegments?.length || 0, 0, `${date}: no Edoyun videos on weekdays`);
      if (date <= '2027-05-10') {
        assert.equal(task.track, 'ls', `${date}: the first pass keeps its original weekdays`);
        assert.ok(task.id.startsWith('ls40-'));
      } else {
        assert.equal(task.durationMinutes, 40);
        assert.equal(task.segments?.length || 0, 0, 'After May 10 no fixed Zero Voice viewing is assigned');
        if (offset <= 1) {
          assert.equal(task.track, 'review', `${date}: Monday and Tuesday prepare for interviews`);
          assert.equal(task.goalId, 'career');
        } else {
          assert.equal(task.track, 'ydy', `${date}: Wednesday through Friday advance the project`);
          assert.ok(data.milestones.some(goal => goal.kind === 'project' && goal.id === task.goalId));
        }
      }
    }
    const saturday = isoDate(Date.parse(`${week.start}T00:00:00Z`) + 5 * 86400000);
    const saturdayTasks = week.tasks.filter(task => task.date === saturday);
    assert.ok(saturdayTasks.length >= 2 && saturdayTasks.length <= 3, `${saturday}: split the five-hour session into actionable blocks`);
    almostEqual(dayTotals.get(saturday) || 0, 300, `${saturday}: Saturday retains five project hours`);
    const total = sum([...dayTotals.values()]);
    assert.ok(total <= 525 + 1e-7, `Week ${week.week} exceeds five 45-minute weekdays plus five Saturday hours`);
    almostEqual(week.scheduledMinutes, total, `Week ${week.week}: scheduled time equals all assigned work`);
    almostEqual(week.totalMin, sum(week.tasks.filter(task => task.id.startsWith('ls40-')).map(task => task.durationMinutes)), `Week ${week.week}: legacy totalMin retains original video minutes`);
  });
});

test('34 course weeks and 18 project weeks have separate numbering and topics for their actual assignments', () => {
  assert.deepEqual(data.planPhases.map(phase => [phase.id, phase.startWeek, phase.endWeek, phase.start, phase.end]), [
    ['courses', 1, 34, '2026-10-05', '2027-05-30'],
    ['projects', 35, 52, '2027-05-31', '2027-10-03'],
  ]);
  assert.equal(data.planPhases[0].deadline, '2027-05-31');
  const assignedWeeks = [];
  for (const phase of data.planPhases) {
    const phaseWeeks = data.weeks.filter(week => week.phaseId === phase.id);
    assert.equal(phaseWeeks.length, phase.endWeek - phase.startWeek + 1);
    assert.equal(phaseWeeks[0].start, phase.start);
    assert.equal(phaseWeeks.at(-1).end, phase.end);
    phaseWeeks.forEach((week, index) => {
      assert.equal(week.week, phase.startWeek + index);
      assert.equal(week.phaseWeek, index + 1);
      assignedWeeks.push(week.week);
      const expectedTracks = [...new Set(week.tasks.map(task => task.track))].sort();
      assert.deepEqual(week.topics.map(topic => topic.track).sort(), expectedTracks, `Week ${week.week}: every assigned source needs its own topic`);
      for (const topic of week.topics) {
        assert.ok(typeof topic.title === 'string' && topic.title.trim());
        assert.equal(topic.label, topic.track === 'ls' ? '零声' : topic.track === 'review' ? '面试' : phase.id === 'courses' ? '易道云' : '项目');
        if (topic.track === 'ls') {
          const lessonIds = [...new Set(week.tasks.filter(task => task.track === 'ls').flatMap(task => task.segments.map(segment => segment.lessonId)))];
          assert.deepEqual(topic.sourceLessonIds, lessonIds, `Week ${week.week}: the Zero Voice topic references exactly this week's original lessons`);
          assert.equal(phase.id, 'courses');
        }
      }
      if (phase.id === 'projects') {
        assert.ok(week.tasks.every(task => !task.segments?.length && !task.learningSegments?.length), 'The separate project phase cannot contain course viewing');
      }
    });
  }
  assert.deepEqual(assignedWeeks, data.weeks.map(week => week.week), 'Phases cover the schedule without gaps or overlap');
  const lessonTopics = data.weeks.flatMap(week => week.topics.filter(topic => topic.track === 'ls'));
  assert.equal(lessonTopics.length, 32);
  assert.equal(new Set(lessonTopics.map(topic => topic.title)).size, 32, 'The Zero Voice weeks have distinct lesson themes');
});

test('all original zero-voice IDs, dates, segments and 6271 minutes remain unchanged', () => {
  const original = tasks.filter(task => task.id.startsWith('ls40-'));
  assert.ok(original.every(task => task.track === 'ls' && task.activity === 'video'));
  assert.equal(original.length, 156);
  assert.deepEqual(original.map(task => [task.id, task.date, task.durationMinutes, task.segments]), ORIGINAL_SESSIONS);
  assert.equal(sum(original.map(task => task.durationMinutes)), 6271);
  assert.ok(original.every(task => task.week <= 32));
  assert.equal(original.at(-1).date, '2027-05-10');
  assert.deepEqual(tasks.filter(task => task.track === 'ls').map(task => task.id), original.map(task => task.id), 'Only the preserved first pass uses the Zero Voice track');
  assert.equal(data.courseCatalog.length, 207);
  const lessons = new Map(data.courseCatalog.map(lesson => [lesson.id, lesson]));
  assert.equal(lessons.size, 207);
  const covered = new Map();
  for (const task of original) {
    almostEqual(sum(task.segments.map(segment => segment.endMinute - segment.startMinute)), task.durationMinutes, `${task.id}: original segment minutes`);
    for (const segment of task.segments) {
      assert.ok(lessons.has(segment.lessonId), 'Every original segment resolves to an original lesson');
      const previousEnd = covered.get(segment.lessonId) || 0;
      assert.equal(segment.startMinute, previousEnd, `${segment.lessonId}: no repeated or skipped original video minutes`);
      assert.ok(segment.endMinute > segment.startMinute);
      covered.set(segment.lessonId, segment.endMinute);
    }
  }
  assert.equal(covered.size, 207);
  for (const lesson of lessons.values()) assert.equal(covered.get(lesson.id), lesson.minutes, `${lesson.id}: original lesson is complete`);
});

test('all 165 Edoyun videos are covered continuously exactly once before the May 22 target', () => {
  const expected = new Map(EXPECTED_COURSES.flatMap(course => course.sections.map(([id, seconds]) => [String(id), { course, seconds }])));
  assert.equal(expected.size, 165);
  const progress = new Map();
  const observedOrder = [];
  const learningTasks = tasks.filter(task => task.learningSegments?.length);
  assert.ok(learningTasks.length > 0);
  assert.ok(learningTasks.every(task => task.date <= '2027-05-22'));
  for (const task of learningTasks) {
    assert.equal(task.track, 'ydy', 'Real Edoyun course segments belong to the project track');
    for (const segment of task.learningSegments) {
      const reference = expected.get(String(segment.sectionId));
      assert.ok(reference, `${segment.sectionId}: no unknown or substitute video`);
      assert.equal(segment.courseTitle, reference.course.title);
      assert.ok(task.week >= reference.course.firstWeek && task.week <= reference.course.lastWeek, `${segment.courseTitle}: correct stage window`);
      assert.ok(typeof segment.chapterTitle === 'string' && segment.chapterTitle.trim());
      assert.ok(typeof segment.title === 'string' && segment.title.trim());
      assert.equal(segment.totalSeconds, reference.seconds);
      assert.ok(Number.isInteger(segment.startSecond) && Number.isInteger(segment.endSecond), 'Real timestamps preserve second precision');
      assert.equal(segment.startSecond, progress.get(String(segment.sectionId)) || 0, `${segment.sectionId}: no overlapping or missing seconds`);
      assert.ok(segment.endSecond > segment.startSecond && segment.endSecond <= segment.totalSeconds);
      if (!progress.has(String(segment.sectionId))) observedOrder.push(String(segment.sectionId));
      progress.set(String(segment.sectionId), segment.endSecond);
    }
  }
  assert.deepEqual(observedOrder, [...expected.keys()], 'Courses and their sections follow the complete source order');
  for (const [id, reference] of expected) assert.equal(progress.get(id), reference.seconds, `${id}: full original video covered`);
  assert.equal(sum([...progress.values()]), 303529);
  assert.ok(data.weeks.filter(week => week.week >= 34).every(week => week.tasks.every(task => !task.learningSegments?.length)), 'No new course segments are assigned after the first pass');
  const finalCatchUp = tasks.filter(task => task.date === '2027-05-29');
  assert.equal(finalCatchUp.length, 2, 'May 29 retains the final Saturday catch-up blocks');
  almostEqual(sum(finalCatchUp.map(task => task.durationMinutes)), 300, 'The final catch-up Saturday retains five hours');
  assert.ok(finalCatchUp.some(task => /补漏|回看/.test(task.title + task.summary)), 'May 29 explicitly identifies the remaining course catch-up');
  const afterDeadline = tasks.filter(task => task.date > '2027-05-31');
  assert.ok(afterDeadline.every(task => !task.learningSegments?.length && !task.segments?.length && task.budget.videoMinutes === 0), 'No course viewing remains after the May 31 deadline');
  const deepening = data.weeks.filter(week => week.week >= 35).flatMap(week => week.tasks.filter(task => task.track === 'ydy'));
  assert.ok(deepening.every(task => weekday(task.date) >= 3 && weekday(task.date) <= 6));
  const deepeningMinutes = sum(deepening.map(task => task.durationMinutes));
  assert.equal(deepeningMinutes, 126 * 60, 'Weeks 35–52 reserve 126 hours for deeper project work');
  const finalBuffer = data.weeks.filter(week => week.week >= 50).flatMap(week => week.tasks.filter(task => task.track === 'ydy'));
  assert.equal(sum(finalBuffer.map(task => task.durationMinutes)), 21 * 60, 'The last three weeks retain 21 project hours');
});

test('task details have actionable steps and honest video, practice and buffer budgets', () => {
  for (const task of tasks) {
    assert.ok(typeof task.activity === 'string' && task.activity.trim(), `${task.id}: activity`);
    assert.ok(typeof task.summary === 'string' && task.summary.trim(), `${task.id}: summary`);
    if (!task.id.startsWith('ls40-')) {
      assert.ok(Array.isArray(task.steps) && task.steps.length > 0 && task.steps.every(step => typeof step === 'string' && step.trim()), `${task.id}: executable steps`);
      assert.ok(Array.isArray(task.deliverables) && task.deliverables.length > 0 && task.deliverables.every(item => typeof item === 'string' && item.trim()), `${task.id}: deliverables`);
    }
    if (task.track === 'ydy') assert.ok(typeof task.projectId === 'string' && task.projectId.trim(), `${task.id}: linked project`);
    assert.ok(task.budget && ['videoMinutes', 'practiceMinutes', 'bufferMinutes'].every(key => Number.isFinite(task.budget[key]) && task.budget[key] >= 0), `${task.id}: nonnegative budget components`);
    almostEqual(task.budget.videoMinutes + task.budget.practiceMinutes + task.budget.bufferMinutes, task.durationMinutes, `${task.id}: budget equals task time`);
    const seconds = sum((task.learningSegments || []).map(segment => segment.endSecond - segment.startSecond));
    const originalMinutes = sum((task.segments || []).map(segment => segment.endMinute - segment.startMinute));
    almostEqual(task.budget.videoMinutes, seconds / 60 + originalMinutes, `${task.id}: video budget equals actual assigned viewing`);
    if (task.track === 'ydy' && !task.learningSegments?.length) assert.ok(task.budget.practiceMinutes + task.budget.bufferMinutes > 0, 'Non-video project blocks reserve time for implementation or validation');
  }
});

test('milestone ownership is complete, unique and resolves to scheduled tasks', () => {
  const taskIds = tasks.map(task => task.id);
  assert.equal(data.milestones.filter(goal => goal.kind === 'project').length, 6);
  assert.equal(data.milestones.filter(goal => goal.kind === 'parallel').length, 2);
  const career = data.milestones.find(goal => goal.id === 'career');
  assert.equal(career.kind, 'parallel');
  assert.deepEqual([...career.taskIds].sort(), tasks.filter(task => task.track === 'review').map(task => task.id).sort(), 'Interview tasks belong solely to the career milestone');
  assert.equal(data.applicationMilestone.start, '2027-10-04');
  assert.equal(data.applicationMilestone.end, '2027-10-17');
  assert.ok(data.applicationMilestone.prerequisiteIds.every(id => data.milestones.some(goal => goal.id === id)), 'Application requirements cannot retain a removed milestone');
  assert.equal(new Set(data.milestones.map(goal => goal.id)).size, data.milestones.length);
  const assigned = data.milestones.flatMap(goal => {
    assert.ok(goal.taskIds.length > 0);
    assert.ok(['project', 'parallel'].includes(goal.kind));
    return goal.taskIds;
  });
  assert.equal(new Set(assigned).size, assigned.length, 'A check-in must not advance two goals');
  assert.deepEqual([...assigned].sort(), [...taskIds].sort(), 'Every task advances exactly one milestone');
});

test('practice dependencies are reachable without cycles and weekday outputs are distinct', () => {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const visiting = new Set();
  const visited = new Set();
  function visit(task) {
    assert.ok(!visiting.has(task.id), `${task.id}: dependency cycle would obstruct continuing learning`);
    if (visited.has(task.id)) return;
    visiting.add(task.id);
    for (const id of task.prerequisiteTaskIds || []) {
      assert.ok(byId.has(id), `${task.id}: prerequisite ${id} exists`);
      assert.ok(byId.get(id).date <= task.date, `${task.id}: prerequisite must not be assigned later`);
      visit(byId.get(id));
    }
    visiting.delete(task.id); visited.add(task.id);
  }
  tasks.forEach(visit);
  const weekdays = data.weeks.filter(week => week.phaseId === 'projects').flatMap(week => week.tasks.filter(task => task.track === 'ydy' && weekday(task.date) !== 6));
  assert.equal(weekdays.length, 54);
  assert.ok(weekdays.every(task => task.durationMinutes === 40));
  assert.equal(new Set(weekdays.map(task => task.deliverables.join('；'))).size, 54, 'Each forty-minute project task produces its own specific output');
  const catchup = tasks.filter(task => task.date === '2027-05-29');
  assert.equal(sum(catchup.map(task => task.budget.bufferMinutes)), 300, 'Both final Saturday blocks are available for unfinished coursework before engineering checks');
  assert.ok(catchup.every(task => task.activity === 'buffer'));
});
