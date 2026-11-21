/*
 * Texte der Komponente "Abschnitt" (aufklappbare Karte der Einstellungsseite) in allen 11 Sprachen.
 */
import { spracheVon, type Sprache } from './Stufen.texte';

type Eintrag = Record<Sprache, string>;

export const TEXTE = {
    einblenden: {
        en: 'Show',
        de: 'Einblenden',
        ru: 'Показать',
        pt: 'Mostrar',
        nl: 'Tonen',
        fr: 'Afficher',
        it: 'Mostra',
        es: 'Mostrar',
        pl: 'Pokaż',
        uk: 'Показати',
        'zh-cn': '展开',
    },
    ausblenden: {
        en: 'Hide',
        de: 'Ausblenden',
        ru: 'Скрыть',
        pt: 'Ocultar',
        nl: 'Verbergen',
        fr: 'Masquer',
        it: 'Nascondi',
        es: 'Ocultar',
        pl: 'Ukryj',
        uk: 'Сховати',
        'zh-cn': '收起',
    },
    geaendert: {
        en: 'changed',
        de: 'geändert',
        ru: 'изменено',
        pt: 'alterado',
        nl: 'gewijzigd',
        fr: 'modifié',
        it: 'modificato',
        es: 'modificado',
        pl: 'zmieniono',
        uk: 'змінено',
        'zh-cn': '已更改',
    },
    geaendertTipp: {
        en: 'Something in this section differs from the factory default',
        de: 'In diesem Abschnitt weicht etwas von der Werksvorgabe ab',
        ru: 'В этом разделе что-то отличается от заводских значений',
        pt: 'Nesta secção, algo difere da predefinição de fábrica',
        nl: 'In dit gedeelte wijkt iets af van de fabrieksinstelling',
        fr: 'Dans cette section, quelque chose diffère du réglage d’usine',
        it: 'In questa sezione qualcosa differisce dall’impostazione di fabbrica',
        es: 'En esta sección algo difiere del ajuste de fábrica',
        pl: 'W tej sekcji coś różni się od ustawienia fabrycznego',
        uk: 'У цьому розділі щось відрізняється від заводських значень',
        'zh-cn': '此部分有内容与出厂设置不同',
    },
} satisfies Record<string, Eintrag>;

export type Schluessel = keyof typeof TEXTE;

/** Text in der Sprache. */
export function t(sprache: string, schluessel: Schluessel): string {
    const eintrag: Eintrag = TEXTE[schluessel];
    return eintrag[spracheVon(sprache)] || eintrag.en;
}
