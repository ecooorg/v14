/**
 * Crisis support contacts and distress markers — international defaults.
 * Owner may replace via config later (PRV-6).
 */

export const SUPPORT_CONTACTS: { label: string; value: string }[] = [
  { label: 'International Association for Suicide Prevention (IASP)', value: 'https://www.iasp.info/suicidalthoughts/' },
  { label: 'US & Canada: 988 Suicide & Crisis Lifeline', value: '988' },
  { label: 'US: Crisis Text Line', value: 'Text HOME to 741741' },
  { label: 'Emergency services (varies by country)', value: '911 / 112 / local emergency number' },
];

export const DISTRESS_MARKERS: string[] = [
  "don't want to live", 'dont want to live', 'kill myself', 'suicide', 'suicidal', 'harm myself', 'hurt myself',
  'no reason to live', 'end my life', 'want to die', 'no point in living', 'self-harm', 'self harm',
  'не хочу жить', 'хочу умереть', 'покончить с собой', 'покончить с жизнью', 'убить себя', 'нет смысла жить',
  'суицид', 'самоубийств', 'причинить себе вред', 'наложить на себя руки',
  'не хочу жити', 'хочу померти', 'покінчити з собою', 'вбити себе', 'самогубств',
  'no quiero vivir', 'quiero morir', 'quitarme la vida', 'matarme', 'hacerme daño', 'suicid',
  'não quero viver', 'quero morrer', 'me matar', 'tirar minha vida', 'tirar a minha vida',
  'je ne veux plus vivre', 'je veux mourir', 'me tuer', 'en finir avec la vie', 'me faire du mal',
  'non voglio più vivere', 'voglio morire', 'togliermi la vita', 'uccidermi',
  'will nicht mehr leben', 'will sterben', 'suizid', 'selbstmord', 'mich umbringen',
  'wil niet meer leven', 'zelfmoord', 'zelfdoding',
  'nie chcę żyć', 'chcę umrzeć', 'samobójst', 'zabić się',
  'yaşamak istemiyorum', 'ölmek istiyorum', 'intihar', 'kendimi öldür',
  'أريد أن أموت', 'لا أريد أن أعيش', 'انتحار', 'לא רוצה לחיות', 'להתאבד', 'आत्महत्या', 'मरना चाहता',
  '不想活', '想死', '自杀', '自殺', '死にたい', '죽고 싶', '자살',
];

function normalize(text: string): string {
  return text.toLowerCase().replace(/[\u2018\u2019\u02bc]/g, "'");
}

export function hasDistressMarker(text: string): boolean {
  if (!text) return false;
  const lower = normalize(text);
  return DISTRESS_MARKERS.some((m) => lower.includes(m));
}

/** Scan multiple free-text fields; returns first matching marker or null */
export function findDistressInTexts(texts: (string | undefined | null)[]): string | null {
  for (const t of texts) {
    if (!t) continue;
    const lower = normalize(t);
    for (const m of DISTRESS_MARKERS) {
      if (lower.includes(m)) return m;
    }
  }
  return null;
}
