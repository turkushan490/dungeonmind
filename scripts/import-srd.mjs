#!/usr/bin/env node
// Imports the SRD 5.1 (2014) and SRD 5.2 (2024) data from a local clone of 5e-bits/5e-database
// (the data behind the 5e-srd-api, MIT) into server/data/<ruleset>/rules.json in DungeonMind's own shape.
// SRD content: CC-BY-4.0, Wizards of the Coast. Gaps in the 2024 data are filled from scripts/srd52-gaps.json.
//
//   git clone --depth 1 https://github.com/5e-bits/5e-database /tmp/5e-database
//   node scripts/import-srd.mjs /tmp/5e-database
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const src = process.argv[2];
if (!src) throw new Error('usage: import-srd.mjs <path to 5e-database>');
const ABIL = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
const SPELL_ABILITY = { bard: 'cha', cleric: 'wis', druid: 'wis', paladin: 'cha', ranger: 'wis', sorcerer: 'cha', warlock: 'cha', wizard: 'int' };

const load = (ver, name) => {
  const p = join(src, 'src', ver, 'en', `5e-SRD-${name}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : [];
};
const text = (v) => (Array.isArray(v) ? v.join('\n') : typeof v === 'string' ? v : '');
const ab = (s) => String(s).toLowerCase().slice(0, 3);
const skillId = (idx) => idx.replace(/^skill-/, '');
const optionNames = (from) => (from?.options ?? []).map((o) => o.item?.index ?? o.of?.index).filter(Boolean);

function equipmentHints(cls) {
  const out = [];
  for (const e of cls.starting_equipment ?? []) out.push(`${e.quantity > 1 ? e.quantity + '× ' : ''}${e.equipment.name}`);
  for (const o of cls.starting_equipment_options ?? cls.equipment_options ?? []) if (o.desc) out.push(o.desc);
  return out;
}

function levelsFor(ver, levels, cls) {
  return levels
    .filter((l) => l.class?.index === cls && !l.subclass)
    .sort((a, b) => a.level - b.level)
    .map((l) => {
      const s = l.spellcasting;
      const lv = { level: l.level, profBonus: l.prof_bonus, features: (l.features ?? []).map((f) => f.name) };
      if (s) {
        lv.spellcasting = {
          cantrips: s.cantrips_known,
          known: s.spells_known,
          prepared: s.prepared_spells,
          slots: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => s[`spell_slots_level_${n}`] ?? 0),
        };
      }
      if (l.class_specific) lv.classSpecific = l.class_specific;
      if (l.ability_score_bonuses !== undefined) lv.asi = l.ability_score_bonuses;
      return lv;
    });
}

function classes(ver) {
  const levels = load(ver, 'Levels');
  const subs = load(ver, 'Subclasses');
  return load(ver, 'Classes').map((c) => {
    const skills = (c.proficiency_choices ?? []).find((p) => optionNames(p.from).some((n) => n.startsWith('skill-')));
    return {
      id: c.index,
      name: c.name,
      hitDie: c.hit_die,
      saves: (c.saving_throws ?? []).map((s) => s.index),
      skillChoices: { choose: skills?.choose ?? 2, from: optionNames(skills?.from).filter((n) => n.startsWith('skill-')).map(skillId) },
      proficiencies: (c.proficiencies ?? []).map((p) => p.name).filter((n) => !n.startsWith('Saving Throw')),
      spellAbility: c.spellcasting ? (c.spellcasting.spellcasting_ability?.index ?? SPELL_ABILITY[c.index]) : SPELL_ABILITY[c.index],
      subclasses: subs.filter((s) => s.class.index === c.index).map((s) => ({ id: s.index, name: s.name, desc: text(s.desc ?? s.summary ?? s.description).slice(0, 600) })),
      levels: levelsFor(ver, levels, c.index),
      equipment: equipmentHints(c),
    };
  });
}

function bonuses(list) {
  const out = {};
  for (const b of list ?? []) out[b.ability_score.index] = b.bonus;
  return out;
}

function species(ver) {
  if (ver === '2014') {
    const subs = load(ver, 'Subraces');
    return load(ver, 'Races').map((r) => ({
      id: r.index,
      name: r.name,
      speed: r.speed,
      size: r.size,
      abilityBonuses: bonuses(r.ability_bonuses),
      traits: (r.traits ?? []).map((t) => t.name),
      languages: (r.languages ?? []).map((l) => l.name),
      subspecies: subs.filter((s) => s.race.index === r.index).map((s) => ({ id: s.index, name: s.name, abilityBonuses: bonuses(s.ability_bonuses), traits: (s.racial_traits ?? []).map((t) => t.name) })),
    }));
  }
  const subs = load(ver, 'Subspecies');
  return load(ver, 'Species').map((r) => ({
    id: r.index,
    name: r.name,
    speed: r.speed,
    size: r.size,
    abilityBonuses: {},
    traits: (r.traits ?? []).map((t) => t.name),
    subspecies: subs.filter((s) => s.species?.index === r.index).map((s) => ({ id: s.index, name: s.name, abilityBonuses: {}, traits: (s.traits ?? []).map((t) => t.name) })),
  }));
}

function backgrounds(ver) {
  return load(ver, 'Backgrounds').map((b) => ({
    id: b.index,
    name: b.name,
    skills: (b.starting_proficiencies ?? b.proficiencies ?? []).map((p) => p.index).filter((i) => i.startsWith('skill-')).map(skillId),
    abilityOptions: b.ability_scores ? b.ability_scores.map((a) => a.index) : undefined,
    feat: b.feat?.name ? `${b.feat.name}${b.feat.note ? ` (${b.feat.note})` : ''}` : undefined,
    feature: b.feature ? `${b.feature.name}: ${text(b.feature.desc)}` : undefined,
    equipment: [
      ...(b.starting_equipment ?? []).map((e) => `${e.quantity > 1 ? e.quantity + '× ' : ''}${e.equipment.name}`),
      ...(b.equipment_options ?? []).map((o) => o.desc).filter(Boolean),
      ...(b.starting_gold ? [`${b.starting_gold.quantity} ${b.starting_gold.unit}`] : []),
    ],
  }));
}

function spells(ver) {
  return load(ver, 'Spells').map((s) => {
    const dmg = s.damage?.damage_at_slot_level ?? s.damage?.damage_at_character_level;
    return {
      id: s.index,
      name: s.name,
      level: s.level,
      school: s.school?.name ?? '',
      classes: (s.classes ?? []).map((c) => c.index),
      castingTime: s.casting_time,
      range: s.range,
      duration: s.duration,
      concentration: !!s.concentration,
      ritual: !!s.ritual,
      components: [...(s.components ?? [])].join(', ') + (s.material ? ` (${s.material})` : ''),
      desc: text(s.desc ?? s.description),
      higher: text(s.higher_level) || undefined,
      attack: s.attack_type || undefined,
      save: s.dc?.dc_type?.index || undefined,
      damage: dmg ? `${Object.values(dmg)[0]}${s.damage.damage_type ? ' ' + s.damage.damage_type.name.toLowerCase() : ''}` : undefined,
    };
  });
}

function items(ver) {
  const eq = load(ver, 'Equipment').map((e) => {
    const cats = e.equipment_categories ? e.equipment_categories.map((c) => c.name) : [e.equipment_category?.name, e.weapon_category && `${e.weapon_category} Weapons`].filter(Boolean);
    return {
      id: e.index,
      name: e.name,
      category: cats.join(', '),
      cost: e.cost ? `${e.cost.quantity} ${e.cost.unit}` : undefined,
      weight: e.weight,
      damage: e.damage?.damage_dice,
      damageType: e.damage?.damage_type?.name?.toLowerCase(),
      damage2: e.two_handed_damage?.damage_dice,
      properties: (e.properties ?? []).map((p) => p.name),
      range: e.range ? { normal: e.range.normal, long: e.range.long } : undefined,
      armor: e.armor_class
        ? { base: e.armor_class.base, dexBonus: !!e.armor_class.dex_bonus, maxBonus: e.armor_class.max_bonus ?? undefined, stealthDisadvantage: !!e.stealth_disadvantage, strMin: e.str_minimum || undefined }
        : undefined,
      desc: text(e.desc ?? e.description) || undefined,
    };
  });
  const magic = load(ver, 'Magic-Items')
    .filter((m) => !m.variant)
    .map((m) => ({ id: m.index, name: m.name, category: m.equipment_category?.name ?? 'Wondrous Item', rarity: m.rarity?.name, magic: true, desc: text(m.desc ?? m.description) }));
  return [...eq, ...magic];
}

function monsters(ver) {
  const ac = (a) => (Array.isArray(a) ? (a[0]?.value ?? 10) : (a ?? 10));
  const speed = (s) => Object.entries(s ?? {}).map(([k, v]) => (k === 'walk' ? v : `${k} ${v}`)).join(', ');
  return load(ver, 'Monsters').map((m) => ({
    id: m.index,
    name: m.name,
    size: m.size,
    type: m.type,
    ac: ac(m.armor_class),
    hp: m.hit_points,
    hitDice: m.hit_points_roll ?? m.hit_dice,
    speed: speed(m.speed),
    abilities: { str: m.strength, dex: m.dexterity, con: m.constitution, int: m.intelligence, wis: m.wisdom, cha: m.charisma },
    cr: m.challenge_rating,
    xp: m.xp,
    senses: Object.entries(m.senses ?? {}).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(', ') || undefined,
    languages: m.languages || undefined,
    traits: (m.special_abilities ?? []).map((a) => `${a.name}: ${text(a.desc)}`),
    actions: [...(m.actions ?? []), ...(m.legendary_actions ?? []).map((a) => ({ ...a, name: `Legendary: ${a.name}` }))].map((a) => `${a.name}: ${text(a.desc)}`),
  }));
}

const entries = (list, owner) =>
  list.map((e) => ({ id: e.index, name: e.name, desc: text(e.desc ?? e.description), ...(owner ? owner(e) : {}) }));

function rules(ver) {
  if (ver === '2014') {
    const sections = load(ver, 'Rule-Sections').map((r) => ({ id: r.index, name: r.name, desc: text(r.desc) }));
    return sections;
  }
  return JSON.parse(readFileSync(new URL('./srd52-gaps.json', import.meta.url), 'utf8')).rules;
}

for (const [ver, ruleset] of [['2014', 'srd51'], ['2024', 'srd52']]) {
  const data = {
    ruleset,
    classes: classes(ver),
    species: species(ver),
    backgrounds: backgrounds(ver),
    feats: entries(load(ver, 'Feats')),
    spells: spells(ver),
    items: items(ver),
    monsters: monsters(ver),
    conditions: entries(load(ver, 'Conditions')),
    skills: load(ver, 'Skills').map((s) => ({ id: s.index, name: s.name, ability: ab(s.ability_score.index) })),
    features: entries(load(ver, 'Features'), (e) => ({ owner: e.class?.index, level: typeof e.level === 'number' ? e.level : Number(String(e.level?.index ?? '').split('-').pop()) || undefined })),
    traits: entries(load(ver, 'Traits'), (e) => ({ owner: (e.races ?? e.species ?? []).map((r) => r.index).join(',') })),
    rules: rules(ver),
  };
  const dir = new URL(`../server/data/${ruleset}/`, import.meta.url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL('rules.json', dir), JSON.stringify(data));
  const counts = Object.fromEntries(Object.entries(data).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length]));
  console.log(ruleset, JSON.stringify(counts));
}
