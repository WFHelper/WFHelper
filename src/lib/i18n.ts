import { derived, writable } from "svelte/store";
import { en, type MessageKey } from "../i18n/en.js";

type MessageParamValue = string | number;
type MessageParams = Record<string, MessageParamValue>;
type LocaleCode = "en";
type LocaleDictionary = Record<MessageKey, string>;
type Translator = (key: MessageKey, params?: MessageParams) => string;

const dictionaries: Record<LocaleCode, LocaleDictionary> = {
  en,
};

const locale = writable<LocaleCode>("en");

function interpolate(template: string, params: MessageParams): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = params[key];
    return value == null ? `{${key}}` : String(value);
  });
}

function createTranslator(dict: LocaleDictionary): Translator {
  return (key, params = {}) => {
    const template = dict[key] || key;
    return interpolate(template, params);
  };
}

export const tr = derived(locale, ($locale) => {
  const dict = dictionaries[$locale] || dictionaries.en;
  return createTranslator(dict);
});

export type { MessageKey,    };
