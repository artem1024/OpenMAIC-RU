#!/usr/bin/env python3
"""
Russian text normalizer for TTS (edge-tts).

Used by:
  - speech.py (audiobook generator)
  - OpenMAIC-RU (osvaivai TTS provider)

Pipeline: ёфикация → аббревиатуры → даты → порядковые числительные → англицизмы → cleanup

CLI usage:
  python3 normalizer.py "текст для нормализации"
  echo "текст" | python3 normalizer.py
"""

import os
import re
import sys

from num2words import num2words

# ─── RUAccent (lazy-loaded) ───────────────────────────────────────────────────

_accentizer = None


def _get_accentizer():
    """Lazy-load RUAccent model (turbo3.1). Loaded once, reused across calls."""
    global _accentizer
    if _accentizer is None:
        try:
            from ruaccent import RUAccent
            _accentizer = RUAccent()
            model = os.environ.get('TTS_ACCENT_MODEL', 'turbo3.1')
            use_dict = os.environ.get('TTS_ACCENT_DICT', '0') == '1'
            _accentizer.load(omograph_model_size=model, use_dictionary=use_dict)
        except Exception as e:
            print(f"  ⚠ RUAccent load failed: {e}", file=sys.stderr)
            _accentizer = False  # Mark as failed, don't retry
    return _accentizer


# ─── Proper noun stress dictionary ────────────────────────────────────────────

_PROPER_NOUNS: dict[str, str] | None = None
_PROPER_NOUNS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                  'data', 'proper_nouns', 'PyDictionaries')


def _load_proper_nouns() -> dict[str, str]:
    """Load proper noun stress dictionary. Loaded once."""
    global _PROPER_NOUNS
    if _PROPER_NOUNS is not None:
        return _PROPER_NOUNS

    _PROPER_NOUNS = {}
    dict_file = os.path.join(_PROPER_NOUNS_DIR, 'proper_nouns_stress.py')
    if not os.path.exists(dict_file):
        print(f"  ⚠ Proper noun dictionary not found: {dict_file}", file=sys.stderr)
        return _PROPER_NOUNS

    local_ns: dict = {}
    with open(dict_file, 'r', encoding='utf-8') as f:
        exec(f.read(), {'__builtins__': {}}, local_ns)
    for val in local_ns.values():
        if isinstance(val, dict):
            _PROPER_NOUNS = val
            break

    print(f"  Loaded {len(_PROPER_NOUNS)} proper nouns", file=sys.stderr)
    return _PROPER_NOUNS


def _fix_proper_noun_stress(text: str) -> str:
    """Replace proper nouns with stressed forms from dictionary."""
    nouns = _load_proper_nouns()
    if not nouns:
        return text

    def _replace_word(m: re.Match) -> str:
        word = m.group(0)
        # Only check capitalized words (proper nouns)
        if not word[0].isupper():
            return word
        stressed = nouns.get(word)
        if stressed:
            return stressed
        return word

    return re.compile(r'[а-яА-ЯёЁ]+').sub(_replace_word, text)


def _apply_ruaccent(text: str) -> str:
    """Apply RUAccent for yo-restoration and homograph resolution.

    Stress marks (+) are removed completely here, because edge-tts (Azure Neural TTS)
    often struggles with explicit Unicode stress marks, distorting the natural accent.
    We retain RUAccent solely for its excellent "yo" (ё) restoration capabilities.
    """
    ac = _get_accentizer()
    if not ac:
        return text
    try:
        result = ac.process_all(text)
        # Strip all pluses added by RUAccent
        result = result.replace('+', '')
        return result
    except Exception:
        return text



# ─── Ё-dictionary (safe, unambiguous replacements only) ──────────────────────

_YO_DICT: dict[str, str] = {}


def _build_yo_dict() -> dict[str, str]:
    """Build dictionary of safe е→ё replacements. No homograph risk."""
    entries: dict[str, str] = {
        # Pronouns & particles
        'мое': 'моё', 'твое': 'твоё', 'свое': 'своё', 'нее': 'неё',
        'еще': 'ещё', 'учет': 'учёт', 'причем': 'причём',
        'почем': 'почём', 'ничье': 'ничьё', 'чье': 'чьё',
        # Adverbs
        'вперед': 'вперёд', 'подчеркнуто': 'подчёркнуто',
        # Nouns — nature
        'береза': 'берёза', 'березы': 'берёзы', 'березе': 'берёзе',
        'березу': 'берёзу', 'березой': 'берёзой', 'черемуха': 'черёмуха',
        'озер': 'озёр', 'звезды': 'звёзды', 'звезд': 'звёзд',
        'пчелы': 'пчёлы', 'пчел': 'пчёл', 'орел': 'орёл', 'козел': 'козёл',
        # Nouns — people
        'ребенок': 'ребёнок', 'ребенка': 'ребёнка', 'ребенку': 'ребёнку',
        'ребенком': 'ребёнком', 'жены': 'жёны', 'жен': 'жён',
        'сестры': 'сёстры', 'сестер': 'сестёр', 'теща': 'тёща', 'тезка': 'тёзка',
        # Nouns — objects
        'елка': 'ёлка', 'елки': 'ёлки', 'елку': 'ёлку', 'елке': 'ёлке',
        'елкой': 'ёлкой', 'емкость': 'ёмкость', 'емкости': 'ёмкости',
        'самолет': 'самолёт', 'самолета': 'самолёта', 'самолеты': 'самолёты',
        'самолетов': 'самолётов', 'счет': 'счёт', 'счета': 'счёта',
        'расчет': 'расчёт', 'расчета': 'расчёта', 'расчетов': 'расчётов',
        'отчет': 'отчёт', 'отчета': 'отчёта', 'отчетов': 'отчётов',
        'маневр': 'манёвр', 'прием': 'приём', 'приема': 'приёма',
        'подъем': 'подъём', 'подъема': 'подъёма',
        'объем': 'объём', 'объема': 'объёма', 'объемов': 'объёмов',
        'клен': 'клён',
        # Nouns — science
        'ученый': 'учёный', 'ученого': 'учёного', 'ученые': 'учёные',
        'ученых': 'учёных', 'ученым': 'учёным', 'учеными': 'учёными',
        'приемник': 'приёмник', 'трехмерный': 'трёхмерный',
        'четырехмерный': 'четырёхмерный',
        # Verbs — past tense
        'нес': 'нёс', 'вел': 'вёл', 'шел': 'шёл',
        'пришел': 'пришёл', 'ушел': 'ушёл', 'нашел': 'нашёл',
        'зашел': 'зашёл', 'перешел': 'перешёл', 'подошел': 'подошёл',
        'произнес': 'произнёс', 'привел': 'привёл', 'провел': 'провёл',
        'довел': 'довёл', 'завел': 'завёл', 'приобрел': 'приобрёл',
        'обрел': 'обрёл', 'протек': 'протёк', 'потек': 'потёк', 'затек': 'затёк',
        # Verbs — present/future
        'идет': 'идёт', 'найдет': 'найдёт', 'пойдет': 'пойдёт',
        'придет': 'придёт', 'уйдет': 'уйдёт', 'подойдет': 'подойдёт',
        'перейдет': 'перейдёт', 'дает': 'даёт', 'задает': 'задаёт',
        'создает': 'создаёт', 'передает': 'передаёт',
        'остается': 'остаётся', 'удается': 'удаётся',
        'начнет': 'начнёт', 'поймет': 'поймёт', 'возьмет': 'возьмёт',
        'назовет': 'назовёт', 'несет': 'несёт', 'ведет': 'ведёт',
        'произведет': 'произведёт', 'приведет': 'приведёт',
        'проведет': 'проведёт', 'принесет': 'принесёт',
        'произнесет': 'произнесёт', 'придется': 'придётся',
        # Verbs — imperatives
        'найдем': 'найдём', 'пойдем': 'пойдём', 'начнем': 'начнём',
        'рассмотрем': 'рассмотрём', 'поймем': 'поймём', 'возьмем': 'возьмём',
        'перейдем': 'перейдём', 'разберем': 'разберём', 'подведем': 'подведём',
        # Adjectives — colors
        'зеленый': 'зелёный', 'зеленая': 'зелёная', 'зеленое': 'зелёное',
        'зеленые': 'зелёные', 'зеленого': 'зелёного', 'зеленой': 'зелёной',
        'зеленых': 'зелёных', 'зеленому': 'зелёному', 'зеленым': 'зелёным',
        'зелеными': 'зелёными',
        'черный': 'чёрный', 'черная': 'чёрная', 'черное': 'чёрное',
        'черные': 'чёрные', 'черного': 'чёрного', 'черной': 'чёрной',
        'черных': 'чёрных', 'черном': 'чёрном', 'черным': 'чёрным',
        'черными': 'чёрными',
        'желтый': 'жёлтый', 'желтая': 'жёлтая', 'желтое': 'жёлтое',
        'желтые': 'жёлтые', 'желтого': 'жёлтого', 'желтой': 'жёлтой',
        'желтых': 'жёлтых',
        # Adjectives — temperature/darkness
        'темный': 'тёмный', 'темная': 'тёмная', 'темное': 'тёмное',
        'темные': 'тёмные', 'темного': 'тёмного', 'темной': 'тёмной',
        'темных': 'тёмных', 'темном': 'тёмном',
        'теплый': 'тёплый', 'теплая': 'тёплая', 'теплое': 'тёплое',
        'теплые': 'тёплые', 'теплого': 'тёплого', 'теплой': 'тёплой',
        'теплых': 'тёплых',
        'тяжелый': 'тяжёлый', 'тяжелая': 'тяжёлая', 'тяжелое': 'тяжёлое',
        'тяжелые': 'тяжёлые', 'тяжелого': 'тяжёлого', 'тяжелой': 'тяжёлой',
        'тяжелых': 'тяжёлых',
        'далекий': 'далёкий', 'далекая': 'далёкая', 'далекое': 'далёкое',
        'далекие': 'далёкие', 'далекого': 'далёкого', 'далекой': 'далёкой',
        # Short adjective forms
        'тяжел': 'тяжёл', 'далек': 'далёк', 'темен': 'тёмен',
        # Misc
        'острие': 'остриё',
        # Numerals
        'трех': 'трёх', 'трем': 'трём', 'четырех': 'четырёх',
        'четырем': 'четырём', 'пятерка': 'пятёрка', 'семерка': 'семёрка',
        'девятерка': 'девятёрка', 'десятерка': 'десятёрка',
    }
    return entries


_YO_DICT = _build_yo_dict()


def _restore_yo(text: str) -> str:
    """Restore ё in Russian words where it was written as е (safe replacements only)."""
    def replace_word(m: re.Match) -> str:
        word = m.group(0)
        lower = word.lower()
        replacement = _YO_DICT.get(lower)
        if not replacement:
            return word
        # Preserve ALL CAPS
        if word == word.upper():
            return replacement.upper()
        # Preserve capitalized first letter
        if word[0] == word[0].upper():
            return replacement[0].upper() + replacement[1:]
        return replacement
    return re.compile(r'[а-яА-ЯёЁ]+').sub(replace_word, text)


# ── Numbers ────────────────────────────────────────────────────────────────

def _to_ordinal(n: int, case: str) -> str:
    """Convert number to masculine ordinal in given grammatical case using num2words."""
    base = num2words(n, lang='ru', to='ordinal')
    # num2words returns nominative ('восемнадцатый'). Decline to target case.
    if case == 'nom':
        return base
    # Determine the ending to replace based on the last word
    words = base.rsplit(' ', 1)
    last = words[-1] if words else base
    prefix = ' '.join(words[:-1]) + ' ' if len(words) > 1 else ''

    # Handle "третий" specially
    if last == 'третий':
        declined = {'gen': 'третьего', 'dat': 'третьему',
                     'inst': 'третьим', 'prep': 'третьем'}.get(case, last)
        return prefix + declined

    # Standard masculine ordinal endings: -ый/-ой → -ого/-ому/-ым/-ом
    case_endings = {'gen': 'ого', 'dat': 'ому', 'inst': 'ым', 'prep': 'ом'}
    ending = case_endings.get(case)
    if not ending:
        return base
    # Strip -ый or -ой and append target ending
    if last.endswith('ый') or last.endswith('ой'):
        return prefix + last[:-2] + ending
    # Strip -ий (for soft adjectives like "шестой" → already handled by -ой)
    if last.endswith('ий'):
        return prefix + last[:-2] + ending
    return base


def _decline_cardinal_genitive(text: str) -> str:
    """Decline nominative cardinal numbers (from num2words) to genitive case."""
    words = text.split()
    declined = []
    mapping = {
        'один': 'одного', 'одна': 'одной', 'одно': 'одного',
        'два': 'двух', 'две': 'двух', 'три': 'трёх', 'четыре': 'четырёх',
        'сорок': 'сорока', 'девяносто': 'девяноста', 'сто': 'ста',
        'двести': 'двухсот', 'триста': 'трёхсот', 'четыреста': 'четырёхсот',
        'тысяча': 'тысячи', 'миллион': 'миллиона', 'миллиард': 'миллиарда',
        'тысячи': 'тысяч', 'миллионы': 'миллионов', 'миллиарды': 'миллиардов'
    }
    for w in words:
        if w in mapping:
            declined.append(mapping[w])
        elif w.endswith('ь'): # 5..20, 30
            declined.append(w[:-1] + 'и')
        elif w.endswith('десяти'):
            declined.append(w)
        elif w.endswith('десят'): # 50..80 -> пятидесяти
            declined.append(w[:-5] + 'идесяти')
        elif w.endswith('сот'): # 500..900 -> пятисот
            declined.append(w[:-3] + 'исот')
        else:
            declined.append(w)
    return ' '.join(declined)


def _to_cardinal(n: int, case: str = 'nom') -> str:
    """Convert number to cardinal in given case."""
    if n == 0:
        return 'ноль'
    try:
        word = num2words(n, lang='ru')
    except Exception:
        return str(n)
    
    if case == 'gen':
        return _decline_cardinal_genitive(word)
    return word


def _expand_cardinal_numbers(text: str) -> str:
    """Expand standalone cardinal numbers to words: '42' → 'сорок два', 'из 17' → 'из семнадцати'."""
    r = text
    
    negative_lookaheads = r'(?!\d|[.,]\d|[-‑][а-яА-ЯёЁ]|\s*(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря|век|класс|урок|раздел|том|этаж|курс|этап|столети|параграф|год[а-яё]*|раз[а-яё]*))'
    
    # 1. Genitive prepositions
    genitive_preps = r'(?<![а-яА-ЯёЁa-zA-Z])(из|от|до|у|без|для|около|вокруг|кроме|вместо|после|свыше|менее|более)\s+'
    r = re.sub(
        rf'{genitive_preps}(\d{{1,15}}){negative_lookaheads}',
        lambda m: m.group(1) + ' ' + _to_cardinal(int(m.group(2)), 'gen'),
        r,
        flags=re.IGNORECASE
    )

    # 2. Match remaining standalone numbers (nominative)
    r = re.sub(
        rf'(?<!\d)(?<![.,])(\d{{1,15}}){negative_lookaheads}',
        lambda m: _to_cardinal(int(m.group(1)), 'nom'),
        r
    )
    return r


# Cyrillic word boundary helpers (Python \b doesn't work for Cyrillic)
_CYR = r'[а-яА-ЯёЁ]'
_NOT_CYR_BEFORE = rf'(?<!{_CYR})'
_NOT_CYR_AFTER = rf'(?!{_CYR})'


def _expand_ordinals(text: str) -> str:
    """Expand ordinal numbers: 'в 18 веке' → 'в восемнадцатом веке'."""
    r = text

    # Prepositional with "в/во"
    def _prep_v(m):
        o = _to_ordinal(int(m.group(2)), 'prep')
        return f'{m.group(1).lower()} {o} {m.group(3).lower()}' if o else m.group(0)
    r = re.sub(
        rf'{_NOT_CYR_BEFORE}(во?)\s+(\d{{1,4}})\s+(веке|классе|уроке|разделе|столетии|параграфе|томе|этаже|курсе|этапе){_NOT_CYR_AFTER}',
        _prep_v, r, flags=re.IGNORECASE)

    # Prepositional with "на"
    r = re.sub(
        rf'{_NOT_CYR_BEFORE}(на)\s+(\d{{1,4}})\s+(уроке|этаже|курсе|этапе){_NOT_CYR_AFTER}',
        _prep_v, r, flags=re.IGNORECASE)

    # Dative with "к"
    def _dat_k(m):
        o = _to_ordinal(int(m.group(2)), 'dat')
        return f'{m.group(1).lower()} {o} {m.group(3).lower()}' if o else m.group(0)
    r = re.sub(
        rf'{_NOT_CYR_BEFORE}(к)\s+(\d{{1,4}})\s+(веку|классу|уроку){_NOT_CYR_AFTER}',
        _dat_k, r, flags=re.IGNORECASE)

    # Genitive (before nominative to avoid partial match)
    def _gen(m):
        o = _to_ordinal(int(m.group(1)), 'gen')
        return f'{o} {m.group(2).lower()}' if o else m.group(0)
    r = re.sub(
        rf'(?<!\d)(\d{{1,4}})\s+(века|класса|урока|раздела|столетия|тома|параграфа|этажа|курса){_NOT_CYR_AFTER}',
        _gen, r, flags=re.IGNORECASE)

    # Instrumental
    def _inst(m):
        o = _to_ordinal(int(m.group(1)), 'inst')
        return f'{o} {m.group(2).lower()}' if o else m.group(0)
    r = re.sub(
        rf'(?<!\d)(\d{{1,4}})\s+(веком|классом|уроком|разделом|томом){_NOT_CYR_AFTER}',
        _inst, r, flags=re.IGNORECASE)

    # Nominative (last)
    def _nom(m):
        o = _to_ordinal(int(m.group(1)), 'nom')
        return f'{o} {m.group(2).lower()}' if o else m.group(0)
    r = re.sub(
        rf'(?<!\d)(\d{{1,4}})\s+(век|класс|урок|раздел|том|параграф|этаж|курс){_NOT_CYR_AFTER}',
        _nom, r, flags=re.IGNORECASE)

    # Hyphenated: "18-й" → "восемнадцатый"
    for suffix, case in [('го', 'gen'), ('му', 'dat'), ('ым', 'inst'), ('й', 'nom'), ('м', 'prep')]:
        def _hyph(m, c=case):
            return _to_ordinal(int(m.group(1)), c) or m.group(0)
        r = re.sub(rf'(?<!\d)(\d{{1,4}})-{suffix}{_NOT_CYR_AFTER}', _hyph, r)

    return r


def _expand_dates(text: str) -> str:
    """Expand dates: '12 января' → 'двенадцатого января'."""
    months = 'января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря'
    def _repl(m):
        o = _to_ordinal(int(m.group(1)), 'gen')
        return f'{o} {m.group(2).lower()}' if o else m.group(0)
    return re.sub(rf'(?<!\d)(\d{{1,4}})\s+({months}){_NOT_CYR_AFTER}', _repl, text, flags=re.IGNORECASE)


def _expand_years(text: str) -> str:
    """Expand year expressions: 'в 2024 году' → 'в две тысячи двадцать четвёртом году'."""
    r = text

    # «в/во N году» → prepositional ordinal
    def _prep_year(m):
        o = _to_ordinal(int(m.group(2)), 'prep')
        return f'{m.group(1).lower()} {o} году' if o else m.group(0)
    r = re.sub(
        rf'{_NOT_CYR_BEFORE}(во?)\s+(\d{{3,4}})\s+году{_NOT_CYR_AFTER}',
        _prep_year, r, flags=re.IGNORECASE)

    # «N года» → genitive ordinal (e.g. «2024 года» → «две тысячи двадцать четвёртого года»)
    def _gen_year(m):
        o = _to_ordinal(int(m.group(1)), 'gen')
        return f'{o} года' if o else m.group(0)
    r = re.sub(
        rf'(?<!\d)(\d{{3,4}})\s+года{_NOT_CYR_AFTER}',
        _gen_year, r, flags=re.IGNORECASE)

    # «N год» — nominative
    def _nom_year(m):
        o = _to_ordinal(int(m.group(1)), 'nom')
        return f'{o} год' if o else m.group(0)
    r = re.sub(
        rf'(?<!\d)(\d{{3,4}})\s+год{_NOT_CYR_AFTER}',
        _nom_year, r, flags=re.IGNORECASE)

    # «с N годом» — instrumental
    def _inst_year(m):
        o = _to_ordinal(int(m.group(2)), 'inst')
        return f'{m.group(1).lower()} {o} годом' if o else m.group(0)
    r = re.sub(
        rf'{_NOT_CYR_BEFORE}(с)\s+(\d{{3,4}})\s+годом{_NOT_CYR_AFTER}',
        _inst_year, r, flags=re.IGNORECASE)

    return r


def _expand_multiplier(text: str) -> str:
    """Expand 'в N раз(а)' with correct accusative case: 'в 1000 раз' → 'в одну тысячу раз'."""
    def _repl(m):
        n = int(m.group(1))
        try:
            word = num2words(n, lang='ru')
        except Exception:
            return m.group(0)
        # Nominative → accusative for feminine numerals (тысяча, etc.)
        word = re.sub(r'\bодна тысяча\b', 'одну тысячу', word)
        word = re.sub(r'\bодна\b', 'одну', word)
        # Choose раз/раза
        suffix = 'раз'
        abs_n = abs(n) % 100
        if abs_n not in range(11, 20):
            last = abs_n % 10
            if 2 <= last <= 4:
                suffix = 'раза'
        return f'в {word} {suffix}'
    return re.sub(
        rf'{_NOT_CYR_BEFORE}в\s+(\d{{1,15}})\s+раз[а]?{_NOT_CYR_AFTER}',
        _repl, text, flags=re.IGNORECASE)


def _agree_unit(n: int, one: str, few: str, many: str) -> str:
    """Agree unit with number: 1 миллиард, 3 миллиарда, 5 миллиардов."""
    abs_n = abs(n) % 100
    if 11 <= abs_n <= 19:
        return many
    last = abs_n % 10
    if last == 1:
        return one
    if 2 <= last <= 4:
        return few
    return many


def _expand_abbreviations(text: str) -> str:
    """Expand abbreviations and acronyms for TTS."""
    r = text

    # Dot-abbreviated words
    r = re.sub(rf'{_NOT_CYR_BEFORE}до\s+н\.\s*э\.', 'до нашей эры', r, flags=re.IGNORECASE)
    r = re.sub(rf'{_NOT_CYR_BEFORE}н\.\s*э\.', 'нашей эры', r, flags=re.IGNORECASE)
    r = re.sub(rf'{_NOT_CYR_BEFORE}т\.д\.', 'так далее', r)
    r = re.sub(rf'{_NOT_CYR_BEFORE}т\.п\.', 'тому подобное', r)
    r = re.sub(rf'{_NOT_CYR_BEFORE}т\.е\.', 'то есть', r)
    r = re.sub(rf'{_NOT_CYR_BEFORE}т\.к\.', 'так как', r)
    r = re.sub(rf'{_NOT_CYR_BEFORE}напр\.', 'например', r)
    r = re.sub(rf'{_NOT_CYR_BEFORE}др\.', 'другие', r)
    r = re.sub(rf'{_NOT_CYR_BEFORE}см\.', 'смотри', r)
    r = re.sub(rf'{_NOT_CYR_BEFORE}проф\.', 'профессор', r, flags=re.IGNORECASE)
    r = re.sub(rf'{_NOT_CYR_BEFORE}акад\.', 'академик', r, flags=re.IGNORECASE)
    r = re.sub(rf'{_NOT_CYR_BEFORE}д-р{_NOT_CYR_AFTER}', 'доктор', r)
    r = re.sub(rf'{_NOT_CYR_BEFORE}гг\.', 'годов', r)
    r = re.sub(rf'{_NOT_CYR_BEFORE}вв\.', 'веков', r)

    # Numeric abbreviations — with number agreement
    def _repl_unit(m, one, few, many):
        num_str = m.group(1)
        n = int(num_str)
        return f'{num_str} {_agree_unit(n, one, few, many)}'

    r = re.sub(rf'(\d+)\s*млрд{_NOT_CYR_AFTER}',
               lambda m: _repl_unit(m, 'миллиард', 'миллиарда', 'миллиардов'), r)
    r = re.sub(rf'(\d+)\s*млн{_NOT_CYR_AFTER}',
               lambda m: _repl_unit(m, 'миллион', 'миллиона', 'миллионов'), r)
    r = re.sub(rf'(\d+)\s*тыс\.',
               lambda m: _repl_unit(m, 'тысяча', 'тысячи', 'тысяч'), r)
    # Fallback without preceding number
    r = re.sub(rf'{_NOT_CYR_BEFORE}млрд{_NOT_CYR_AFTER}', 'миллиардов', r)
    r = re.sub(rf'{_NOT_CYR_BEFORE}млн{_NOT_CYR_AFTER}', 'миллионов', r)
    r = re.sub(rf'{_NOT_CYR_BEFORE}тыс\.', 'тысяч', r)
    r = re.sub(rf'{_NOT_CYR_BEFORE}руб\.', 'рублей', r)
    r = re.sub(rf'{_NOT_CYR_BEFORE}коп\.', 'копеек', r)

    # Units (only after digits)
    r = re.sub(rf'(\d)\s*км/ч{_NOT_CYR_AFTER}', r'\1 километров в час', r)
    r = re.sub(rf'(\d)\s*км{_NOT_CYR_AFTER}(?!/)', r'\1 километров', r)
    r = re.sub(rf'(\d)\s*кг{_NOT_CYR_AFTER}', r'\1 килограммов', r)
    r = re.sub(rf'(\d)\s*см{_NOT_CYR_AFTER}', r'\1 сантиметров', r)
    r = re.sub(rf'(\d)\s*мм{_NOT_CYR_AFTER}', r'\1 миллиметров', r)
    r = re.sub(rf'(\d)\s*м{_NOT_CYR_AFTER}(?!/)', r'\1 метров', r)
    r = re.sub(r'(\d)\s*°C', r'\1 градусов Цельсия', r)
    r = re.sub(r'(\d)\s*%', r'\1 процентов', r)

    # Cyrillic acronyms → spelled-out pronunciation
    cyr_acronyms = {
        'ИИ': 'и-и,', 'СССР': 'эс-эс-эс-эр', 'США': 'сэ-шэ-а',
        'ООН': 'оон', 'ВВП': 'вэ-вэ-пэ', 'МВД': 'эм-вэ-дэ',
        'ФСБ': 'эф-эс-бэ', 'ВОЗ': 'воз', 'ДНК': 'дэ-эн-ка',
        'РФ': 'эр-эф', 'ЕС': 'е-эс', 'ВУЗ': 'вуз', 'ВУЗЫ': 'вузы',
        'НИИ': 'ни-и,', 'КПД': 'капэдэ', 'ЭВМ': 'э-вэ-эм',
        'АЭС': 'аэс', 'ГЭС': 'гэс', 'ТЭЦ': 'тэц',
    }
    for acronym, pronunciation in cyr_acronyms.items():
        r = re.sub(rf'{_NOT_CYR_BEFORE}{acronym}{_NOT_CYR_AFTER}', pronunciation, r)

    return r


def _transliterate_english(text: str) -> str:
    """Transliterate common English words/acronyms to Russian phonetic equivalents."""
    # Sorted longest-first to avoid partial matches
    replacements: list[tuple[str, str, int]] = [
        # Multi-word terms (must be first)
        (r'\bmachine\s+learning\b', 'машин лёрнинг', re.IGNORECASE),
        (r'\bdeep\s+learning\b', 'дип лёрнинг', re.IGNORECASE),
        (r'\bdata\s+science\b', 'дата сайенс', re.IGNORECASE),
        (r'\bopen\s+source\b', 'опен сорс', re.IGNORECASE),
        (r'\bbig\s+data\b', 'биг дата', re.IGNORECASE),
        # AI products (before acronyms to avoid partial matches)
        (r'\bChatGPT\b', 'ЧатДжиПиТи', re.IGNORECASE),
        (r'\bGPT[-‑]?4[oо]\b', 'джи-пи-ти-четыре-о', re.IGNORECASE),
        (r'\bGPT[-‑]?4\b', 'джи-пи-ти четыре', re.IGNORECASE),
        (r'\bGPT[-‑]?3\.5\b', 'джи-пи-ти три пять', re.IGNORECASE),
        (r'\bGPT[-‑]?3\b', 'джи-пи-ти три', re.IGNORECASE),
        (r'\bGPT\b', 'джи-пи-ти', 0),
        # Programming languages & frameworks
        (r'\bJavaScript\b', 'ДжаваСкрипт', re.IGNORECASE),
        (r'\bTypeScript\b', 'ТайпСкрипт', re.IGNORECASE),
        (r'\bPython\b', 'Пайтон', re.IGNORECASE),
        (r'\bDocker\b', 'Докер', re.IGNORECASE),
        (r'\bLinux\b', 'Линукс', re.IGNORECASE),
        (r'\bWindows\b', 'Виндоус', re.IGNORECASE),
        (r'\bAndroid\b', 'Андроид', re.IGNORECASE),
        (r'\bGoogle\b', 'Гугл', re.IGNORECASE),
        (r'\bGitHub\b', 'ГитХаб', re.IGNORECASE),
        (r'\bReact\b', 'Реакт', 0),
        (r'\bNext\.?js\b', 'НекстДжейЭс', re.IGNORECASE),
        (r'\bNode\.?js\b', 'НодДжейЭс', re.IGNORECASE),
        # Latin acronyms
        (r'\bHTTPS\b', 'эйч-ти-ти-пи-эс', 0),
        (r'\bHTTP\b', 'эйч-ти-ти-пи', 0),
        (r'\bHTML\b', 'эйч-ти-эм-эль', 0),
        (r'\bCSS\b', 'си-эс-эс', 0),
        (r'\bAPI\b', 'эй-пи-ай', 0),
        (r'\bURL\b', 'ю-ар-эль', 0),
        (r'\bSQL\b', 'эс-кью-эль', 0),
        (r'\bPDF\b', 'пи-ди-эф', 0),
        (r'\bGPU\b', 'джи-пи-ю', 0),
        (r'\bCPU\b', 'си-пи-ю', 0),
        (r'\bSSD\b', 'эс-эс-ди', 0),
        (r'\bRAM\b', 'рам', 0),
        (r'\bLAN\b', 'лан', 0),
        (r'\bVPN\b', 'ви-пи-эн', 0),
        (r'\bUSB\b', 'ю-эс-би', 0),
        (r'\bIoT\b', 'ай-о-ти', 0),
        (r'\bAI\b', 'эй-ай', 0),
        (r'\bLLM\b', 'эл-эл-эм', 0),
        (r'\bML\b', 'эм-эль', 0),
        (r'\bIT\b', 'ай-ти', 0),
        (r'\bPR\b', 'пи-ар', 0),
        (r'\bQR\b', 'кью-ар', 0),
        # Common tech words
        (r'\bWi-?Fi\b', 'вай-фай', re.IGNORECASE),
        (r'\bBluetooth\b', 'блютус', re.IGNORECASE),
        (r'\be-?mail\b', 'имейл', re.IGNORECASE),
        (r'\bonline\b', 'онлайн', re.IGNORECASE),
        (r'\boffline\b', 'офлайн', re.IGNORECASE),
        (r'\bsoftware\b', 'софтвер', re.IGNORECASE),
        (r'\bhardware\b', 'хардвер', re.IGNORECASE),
        (r'\bframework\b', 'фреймворк', re.IGNORECASE),
        (r'\bstartup\b', 'стартап', re.IGNORECASE),
        (r'\bchatbot\b', 'чатбот', re.IGNORECASE),
        (r'\bdataset\b', 'датасет', re.IGNORECASE),
        (r'\bfeedback\b', 'фидбэк', re.IGNORECASE),
        (r'\bserver\b', 'сервер', re.IGNORECASE),
        (r'\bbrowser\b', 'браузер', re.IGNORECASE),
        (r'\brouter\b', 'роутер', re.IGNORECASE),
        (r'\bcluster\b', 'кластер', re.IGNORECASE),
        (r'\btoken\b', 'токен', re.IGNORECASE),
        (r'\bprompt\b', 'промт', re.IGNORECASE),
    ]
    r = text
    for pattern, replacement, flags in replacements:
        r = re.sub(pattern, replacement, r, flags=flags)
    return r


# ─── Main pipeline ────────────────────────────────────────────────────────────

def normalize_for_tts(text: str) -> str:
    """
    Normalize Russian text for TTS.
    Pipeline: аббревиатуры → даты → порядковые → годы → англицизмы → кратность → кардинальные → cleanup → ударения.
    """
    text = _expand_abbreviations(text)
    text = _expand_dates(text)
    text = _expand_ordinals(text)
    text = _expand_years(text)
    text = _transliterate_english(text)
    text = _expand_multiplier(text)
    text = _expand_cardinal_numbers(text)
    # & → "энд" (for brand names like black&white, R&D, etc.)
    text = re.sub(r'&', ' энд ', text)
    # Remove footnote markers like [1], [2], etc.
    text = re.sub(r'\[\d+\]', '', text)
    # Clean up multiple spaces
    text = re.sub(r'  +', ' ', text)
    # Handle literal pluses before they get confused with stress marks
    # e.g. "Google+" -> "Google плюс", "1 + 1" -> "1 плюс 1"
    text = re.sub(r'(\d)\s*\+\s*(\d)', r'\1 плюс \2', text)
    text = re.sub(r'([a-zA-Z])\+', r'\1 плюс', text)

    # Phonetic fixes for specific mispronunciations
    text = re.sub(r'\bзакон Мура\b', 'закон Муур-а', text, flags=re.IGNORECASE)

    text = text.strip()
    # Proper noun stress (before RUAccent — dictionary has priority over neural model)
    text = _fix_proper_noun_stress(text)
    # RUAccent: yo-restoration + homograph resolution (last step, after all text normalization)
    text = _apply_ruaccent(text)
    return text


# ─── CLI ──────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    if len(sys.argv) > 1:
        input_text = sys.argv[1]
    else:
        input_text = sys.stdin.read()
    print(normalize_for_tts(input_text))
