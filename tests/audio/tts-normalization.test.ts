import { describe, it, expect } from 'vitest';
import { _normalizeForTTS_test as normalizeForTTS } from '@/lib/audio/tts-providers';

describe('normalizeForTTS', () => {
  // --- Ёфикация ---
  describe('restoreYo', () => {
    it('restores ё in common words', () => {
      expect(normalizeForTTS('еще раз')).toBe('ещё раз');
      expect(normalizeForTTS('идет дождь')).toBe('идёт дождь');
      expect(normalizeForTTS('зеленый лес')).toBe('зелёный лес');
      expect(normalizeForTTS('черный кот')).toBe('чёрный кот');
      expect(normalizeForTTS('теплый день')).toBe('тёплый день');
    });

    it('preserves capitalization', () => {
      expect(normalizeForTTS('Еще один')).toBe('Ещё один');
      expect(normalizeForTTS('Зеленый')).toBe('Зелёный');
    });

    it('does not touch words already with ё', () => {
      expect(normalizeForTTS('ещё раз')).toBe('ещё раз');
      expect(normalizeForTTS('зелёный')).toBe('зелёный');
    });

    it('handles ALL CAPS words', () => {
      expect(normalizeForTTS('ЕЩЕ')).toBe('ЕЩЁ');
      expect(normalizeForTTS('ЗЕЛЕНЫЙ')).toBe('ЗЕЛЁНЫЙ');
    });

    it('does not touch words not in dictionary', () => {
      expect(normalizeForTTS('текст')).toBe('текст');
      expect(normalizeForTTS('время')).toBe('время');
    });

    it('does not replace dangerous homographs', () => {
      // "берет" can be beret (hat) — must NOT become "берёт"
      expect(normalizeForTTS('красный берет')).toBe('красный берет');
      // "осел" can mean "settled/sank" — must NOT become "осёл"
      expect(normalizeForTTS('дом осел')).toBe('дом осел');
      // "озера" gen.sg — must NOT become "озёра" (nom.pl)
      expect(normalizeForTTS('берег озера')).toBe('берег озера');
    });
  });

  // --- Аббревиатуры ---
  describe('expandAbbreviations', () => {
    it('expands dot-abbreviated words', () => {
      expect(normalizeForTTS('и т.д.')).toBe('и так далее');
      expect(normalizeForTTS('и т.п.')).toBe('и тому подобное');
      expect(normalizeForTTS('т.е. это')).toBe('то есть это');
      expect(normalizeForTTS('до н.э.')).toBe('до нашей эры');
      expect(normalizeForTTS('в 300 г. до н.э.')).toBe('в 300 г. до нашей эры');
    });

    it('expands numeric abbreviations', () => {
      expect(normalizeForTTS('5 млн жителей')).toBe('5 миллионов жителей');
      expect(normalizeForTTS('3 млрд')).toBe('3 миллиардов');
      expect(normalizeForTTS('10 тыс.')).toBe('10 тысяч');
    });

    it('expands units after digits', () => {
      expect(normalizeForTTS('100 км/ч')).toBe('100 километров в час');
      expect(normalizeForTTS('50 км от города')).toBe('50 километров от города');
      expect(normalizeForTTS('5 кг сахара')).toBe('5 килограммов сахара');
      expect(normalizeForTTS('10 см')).toBe('10 сантиметров');
      expect(normalizeForTTS('36°C')).toBe('36 градусов Цельсия');
      expect(normalizeForTTS('90%')).toBe('90 процентов');
    });

    it('does not expand units without preceding digit', () => {
      // "км" without a digit should stay
      const input = 'расстояние в км';
      expect(normalizeForTTS(input)).toBe('расстояние в км');
    });

    it('expands Cyrillic acronyms', () => {
      expect(normalizeForTTS('распад СССР')).toBe('распад эс-эс-эс-эр');
      expect(normalizeForTTS('в США')).toBe('в сэ-шэ-а');
      expect(normalizeForTTS('роль ООН')).toBe('роль о-о-эн');
      expect(normalizeForTTS('рост ВВП')).toBe('рост вэ-вэ-пэ');
      expect(normalizeForTTS('молекула ДНК')).toBe('молекула дэ-эн-ка');
    });
  });

  // --- Даты ---
  describe('expandDates', () => {
    it('expands day + month', () => {
      expect(normalizeForTTS('12 января')).toBe('двенадцатого января');
      expect(normalizeForTTS('1 сентября')).toBe('первого сентября');
      expect(normalizeForTTS('23 февраля')).toBe('двадцать третьего февраля');
      expect(normalizeForTTS('8 марта')).toBe('восьмого марта');
    });

    it('handles all months', () => {
      expect(normalizeForTTS('5 мая')).toBe('пятого мая');
      expect(normalizeForTTS('7 ноября')).toBe('седьмого ноября');
      expect(normalizeForTTS('31 декабря')).toBe('тридцать первого декабря');
    });

    it('does not match month inside longer words', () => {
      // "мая" should not match inside "маяк"
      expect(normalizeForTTS('5 маяков')).toBe('5 маяков');
    });
  });

  // --- Порядковые числительные (уже существующая функциональность) ---
  describe('expandOrdinalNumbers', () => {
    it('expands ordinals in prepositional context', () => {
      expect(normalizeForTTS('в 18 веке')).toBe('в восемнадцатом веке');
      expect(normalizeForTTS('в 3 классе')).toBe('в третьем классе');
    });

    it('expands ordinals in nominative', () => {
      expect(normalizeForTTS('21 век')).toBe('двадцать первый век');
    });

    it('expands hyphenated ordinals', () => {
      expect(normalizeForTTS('18-й')).toBe('восемнадцатый');
      expect(normalizeForTTS('3-го')).toBe('третьего');
    });
  });

  // --- Транслитерация англицизмов ---
  describe('transliterateEnglish', () => {
    it('transliterates common tech acronyms', () => {
      expect(normalizeForTTS('использует API')).toBe('использует эй-пи-ай');
      expect(normalizeForTTS('по HTTP')).toBe('по эйч-ти-ти-пи');
      expect(normalizeForTTS('формат PDF')).toBe('формат пи-ди-эф');
    });

    it('transliterates programming languages', () => {
      expect(normalizeForTTS('написан на Python')).toBe('написан на Пайтон');
      expect(normalizeForTTS('фреймворк React')).toBe('фреймворк Реакт');
    });

    it('transliterates multi-word terms', () => {
      expect(normalizeForTTS('метод machine learning')).toBe('метод машин лёрнинг');
      expect(normalizeForTTS('платформа open source')).toBe('платформа опен сорс');
    });

    it('transliterates common tech words', () => {
      expect(normalizeForTTS('подключить Wi-Fi')).toBe('подключить вай-фай');
      expect(normalizeForTTS('отправить email')).toBe('отправить имейл');
      expect(normalizeForTTS('режим online')).toBe('режим онлайн');
    });

    it('is case-insensitive for common words', () => {
      expect(normalizeForTTS('PYTHON скрипт')).toBe('Пайтон скрипт');
      expect(normalizeForTTS('python скрипт')).toBe('Пайтон скрипт');
    });
  });

  // --- Интеграционный тест: полный пайплайн ---
  describe('full pipeline', () => {
    it('applies all normalizations in correct order', () => {
      const input = 'Ученые в 18 веке еще не знали про ДНК и machine learning';
      const result = normalizeForTTS(input);
      expect(result).toContain('Учёные');          // ёфикация
      expect(result).toContain('восемнадцатом');    // ordinals
      expect(result).toContain('ещё');              // ёфикация
      expect(result).toContain('дэ-эн-ка');         // acronym
      expect(result).toContain('машин лёрнинг');    // transliteration
    });

    it('handles combined date + abbreviation', () => {
      const input = '12 января 2024 г. до н.э.';
      const result = normalizeForTTS(input);
      expect(result).toContain('двенадцатого января');
      expect(result).toContain('до нашей эры');
    });
  });
});
