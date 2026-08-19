/*
 * Bausteine der Klima-Kachel fuer VIS 1.x - iobroker.faikout
 *
 * Jedes Widget bekommt nur EIN Objekt: das Geraet (z. B. faikout.0.Wohnzimmer). Welche
 * Datenpunkte es darunter gibt, ermittelt das Widget selbst - die Anlagen koennen
 * unterschiedlich viel, und der Adapter legt entsprechend unterschiedlich viele Objekte an.
 * Fehlt ein Datenpunkt, zeigt der Baustein einen Hinweis statt eines toten Bedienelements.
 */
'use strict';

vis.binds.faikout = {
    version: '0.0.1',

    /* Rueckfallwerte; die echten Grenzen liefert das Geraet ueber common.min/max/step. */
    MIN: 16,
    MAX: 29,
    SCHRITT: 0.5,

    SYM: {
        auto: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7 15l-3 3-3-3"/><path d="M4 18V9a4 4 0 0 1 4-4"/><path d="M17 9l3-3 3 3"/><path d="M20 6v9a4 4 0 0 1-4 4"/></svg>',
        cool: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9"/><path d="M9.5 4.6L12 6.9l2.5-2.3M9.5 19.4L12 17.1l2.5 2.3"/></svg>',
        heat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"/></svg>',
        dry: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3s6 6.6 6 10.4A6 6 0 0 1 6 13.4C6 9.6 12 3 12 3z"/></svg>',
        fan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1.9"/><path d="M12 10.1c0-2.7.5-4.5 1.6-5.5 1.5-1.4 4-.6 4 1.6 0 2.4-2 3.9-5.6 3.9"/><path d="M13.9 12c2.7 0 4.5.5 5.5 1.6 1.4 1.5.6 4-1.6 4-2.4 0-3.9-2-3.9-5.6"/><path d="M12 13.9c0 2.7-.5 4.5-1.6 5.5-1.5 1.4-4 .6-4-1.6 0-2.4 2-3.9 5.6-3.9"/><path d="M10.1 12c-2.7 0-4.5-.5-5.5-1.6-1.4-1.5-.6-4 1.6-4 2.4 0 3.9 2 3.9 5.6"/></svg>',
        temp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 14.8V4.5a2.5 2.5 0 0 0-5 0v10.3a4.5 4.5 0 1 0 5 0z"/></svg>',
        hum: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5s5.5 6.1 5.5 9.6a5.5 5.5 0 0 1-11 0C6.5 9.6 12 3.5 12 3.5z"/></svg>',

        /* Zusatzfunktionen - reine Symbole, der Name steht im Tooltip */
        swing: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h16M4 8l3-3M4 8l3 3"/><path d="M20 16H4m16 0l-3-3m3 3l-3 3"/></svg>',
        swingv: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v16M12 4l-3 3m3-3l3 3M12 20l-3-3m3 3l3-3"/></svg>',
        swingh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h16M4 12l3-3m-3 3l3 3M20 12l-3-3m3 3l-3 3"/></svg>',
        econo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 20c0-8 5-13 14-14 .5 7-2.5 14-9.5 14C7 20 5.8 20 5 20z"/><path d="M9 16c1.5-3.5 4-6 7-7.5"/></svg>',
        powerful: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4.5 13.5H11L10 22l8.5-11.5H12L13 2z"/></svg>',
        comfort: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12V8.5A2.5 2.5 0 0 1 7.5 6h9A2.5 2.5 0 0 1 19 8.5V12"/><path d="M3.5 12.5A1.5 1.5 0 0 1 5 14v3h14v-3a1.5 1.5 0 0 1 1.5-1.5A1.5 1.5 0 0 1 22 14v4.5H2V14a1.5 1.5 0 0 1 1.5-1.5z"/><path d="M6 20v1M18 20v1"/></svg>',
        streamer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M7 9h10M7 12.5h10M7 16h6"/></svg>',
        sensor: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2.5"/><path d="M6.5 6.5a7.8 7.8 0 0 0 0 11M17.5 6.5a7.8 7.8 0 0 1 0 11M3.5 3.5a12 12 0 0 0 0 17M20.5 3.5a12 12 0 0 1 0 17"/></svg>',
        led: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.5.4.8 1 .8 1.6V16h5.4v-.5c0-.6.3-1.2.8-1.6A6 6 0 0 0 12 3z"/></svg>',
        quiet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6.5 9H3v6h3.5L11 19V5z"/><path d="M16 10.5l4 3M20 10.5l-4 3"/></svg>'
    },

    /**
     * Zusatzfunktionen. Erscheinen nur, wenn die Anlage sie meldet - `comfort` etwa gibt es
     * nur an manchen Geraeten, `sensor`/`led`/`quiet` nur, wenn sie im Modul nicht
     * abgeschaltet sind.
     */
    ZUSATZ: [
        { feld: 'control.swing', name: 'Schwenken', sym: 'swing' },
        { feld: 'control.swingv', name: 'Lamellen senkrecht', sym: 'swingv' },
        { feld: 'control.swingh', name: 'Lamellen waagerecht', sym: 'swingh' },
        { feld: 'control.econo', name: 'Sparbetrieb', sym: 'econo' },
        { feld: 'control.powerful', name: 'Turbo', sym: 'powerful' },
        { feld: 'control.comfort', name: 'Komfortbetrieb', sym: 'comfort' },
        { feld: 'control.streamer', name: 'Luftreinigung', sym: 'streamer' },
        { feld: 'control.sensor', name: 'Anwesenheitssensor', sym: 'sensor' },
        { feld: 'control.led', name: 'Anzeige-LED', sym: 'led' },
        { feld: 'control.quiet', name: 'Leiser Außenbetrieb', sym: 'quiet' }
    ],

    MODI: [
        { wert: 'heat_cool', text: 'Auto', farbe: '#2e7d52', sym: 'auto' },
        { wert: 'cool', text: 'Kühlen', farbe: '#1e86c4', sym: 'cool' },
        { wert: 'heat', text: 'Heizen', farbe: '#c96a22', sym: 'heat' },
        { wert: 'dry', text: 'Trocknen', farbe: '#9a7b33', sym: 'dry' },
        { wert: 'fan_only', text: 'Lüften', farbe: '#5c7186', sym: 'fan' }
    ],

    LUEFTER: [
        { wert: 'auto', text: 'Auto' },
        { wert: 'night', text: 'Nacht' },
        { wert: 'low', text: '1' },
        { wert: 'lowMedium', text: '2' },
        { wert: 'medium', text: '3' },
        { wert: 'mediumHigh', text: '4' },
        { wert: 'high', text: '5' }
    ],

    /** Alle Messwerte, die als Kachel oder Einzelwert zur Verfuegung stehen. */
    MESSWERTE: [
        { schluessel: 'aussen', feld: 'status.outside', name: 'Außen', einheit: '°C', stellen: 1 },
        { schluessel: 'leistung', feld: 'status.consumption', name: 'Leistung', einheit: 'W', stellen: 0 },
        { schluessel: 'heute', feld: 'verbrauch.gesamt.heute', name: 'Heute', einheit: 'kWh', stellen: 1 },
        { schluessel: 'verdichter', feld: 'status.comp', name: 'Verdichter', einheit: 'rpm', stellen: 0 },
        { schluessel: 'ventilator', feld: 'status.fanfreq', name: 'Ventilator', einheit: 'rpm', stellen: 0 },
        { schluessel: 'kaeltemittel', feld: 'status.liquid', name: 'Kältemittel', einheit: '°C', stellen: 1 },
        { schluessel: 'raum', feld: 'status.temp', name: 'Raum', einheit: '°C', stellen: 1 },
        { schluessel: 'feuchte', feld: 'status.hum', name: 'Luftfeuchte', einheit: '%', stellen: 0 },
        { schluessel: 'energie', feld: 'status.energy', name: 'Energie gesamt', einheit: 'kWh', stellen: 1 },
        { schluessel: 'gestern', feld: 'verbrauch.gesamt.gestern', name: 'Gestern', einheit: 'kWh', stellen: 1 },
        { schluessel: 'stunde', feld: 'verbrauch.gesamt.stunde', name: 'Diese Stunde', einheit: 'kWh', stellen: 2 }
    ],

    /* ------------------------------------------------------------------ Hilfen */

    zahl: function (v, stellen) {
        if (v === null || v === undefined || v === '') return null;
        var n = parseFloat(v);
        if (isNaN(n)) return null;
        return n.toFixed(stellen).replace('.', ',');
    },

    /**
     * Gemeinsames Geruest aller Bausteine: wartet auf das DOM, ermittelt die vorhandenen
     * Datenpunkte des Geraets, ruft den Aufbau und haengt die Zustandsbindung ein.
     *
     * @param {function} aufbau  ($wurzel, ctx, data) => zeichnenFunktion
     */
    start: function (widgetID, data, aufbau) {
        var b = vis.binds.faikout;
        var $div = $('#' + widgetID);
        if (!$div.length) {
            return setTimeout(function () { b.start(widgetID, data, aufbau); }, 100);
        }

        var prefix = data.deviceOid;
        if (!prefix) {
            $div.html('<div class="fk"><div class="fk-fehler">Kein Gerät gewählt. Im Attribut ' +
                '„Gerät" ein Objekt wie <code>faikout.0.Wohnzimmer</code> eintragen.</div></div>');
            return;
        }

        vis.conn.getStates(prefix + '.*', function (fehler, zustaende) {
            if (fehler) {
                $div.html('<div class="fk"><div class="fk-fehler">Datenpunkte nicht lesbar: ' + fehler + '</div></div>');
                return;
            }
            zustaende = zustaende || {};
            var ctx = {
                prefix: prefix,
                widgetID: widgetID,
                zustaende: zustaende,
                oid: function (feld) { return prefix + '.' + feld; },
                hat: function (feld) { return Object.prototype.hasOwnProperty.call(zustaende, prefix + '.' + feld); },
                wert: function (feld) {
                    var s = vis.states.attr(prefix + '.' + feld + '.val');
                    return s === undefined ? null : s;
                },
                /** Farbe der aktuellen Betriebsart - faerbt alle Bausteine einheitlich ein. */
                akzent: function () {
                    var an = this.hat('control.power') ? !!this.wert('control.power') : true;
                    if (!an) return '#8593a4';
                    var m = this.wert('control.mode');
                    for (var i = 0; i < b.MODI.length; i++) if (b.MODI[i].wert === m) return b.MODI[i].farbe;
                    return '#1e86c4';
                },
                /** Meldet, dass ein Befehl unterwegs ist - die Anlage bestaetigt erst spaeter. */
                wartet: function ($w) {
                    var $s = $w.find('.fk-status');
                    if (!$s.length) return;
                    $s.text('gesendet · warte auf Rückmeldung').addClass('fk-wartet');
                    clearTimeout($w.data('fkTimer'));
                    $w.data('fkTimer', setTimeout(function () { $s.text('').removeClass('fk-wartet'); }, 65000));
                }
            };

            var $wurzel = $('<div class="fk"></div>')
                .toggleClass('fk-dunkel', data.theme === 'dunkel')
                .toggleClass('fk-blank', data.rahmen === false);
            $div.empty().append($wurzel);

            var zeichnen = aufbau($wurzel, ctx, data);
            if (typeof zeichnen !== 'function') return;

            var gebunden = [];
            Object.keys(zustaende).forEach(function (id) {
                vis.states.bind(id + '.val', zeichnen);
                gebunden.push(id + '.val');
            });
            $div.data('bound', gebunden);
            $div.data('bindHandler', zeichnen);
            zeichnen();
        });
    },

    /** Hinweis, wenn die Anlage den benoetigten Datenpunkt gar nicht hat. */
    fehlt: function ($wurzel, feld) {
        $wurzel.html('<div class="fk-fehler">Dieses Gerät hat keinen Datenpunkt <code>' + feld + '</code>.</div>');
        return null;
    },

    /** Grenzen und Schrittweite des Sollwerts - je Anlage verschieden. */
    grenzen: function (ctx, fertig) {
        var b = vis.binds.faikout;
        var g = { min: b.MIN, max: b.MAX, step: b.SCHRITT };
        vis.conn.getObject(ctx.oid('control.target'), function (err, obj) {
            if (!err && obj && obj.common) {
                if (typeof obj.common.min === 'number') g.min = obj.common.min;
                if (typeof obj.common.max === 'number') g.max = obj.common.max;
                if (typeof obj.common.step === 'number') g.step = obj.common.step;
            }
            fertig(g);
        });
        return g;
    },

    /* ------------------------------------------------------------------ Kopfzeile */

    kopf: function ($wurzel, ctx, data) {
        if (data.kopf === false) return;
        var name = data.titel || ctx.prefix.split('.').pop().replace(/_/g, ' ');
        var $kopf = $('<div class="fk-kopf"></div>');
        $kopf.append($('<div></div>')
            .append($('<div class="fk-name"></div>').text(name))
            .append(data.untertitel ? $('<div class="fk-ort"></div>').text(data.untertitel) : ''));
        if (ctx.hat('control.power') && data.schalter !== false) {
            $('<button type="button" class="fk-schalter" aria-label="Ein/Aus"></button>')
                .on('click', function () {
                    vis.setValue(ctx.oid('control.power'), !ctx.wert('control.power'));
                    ctx.wartet($wurzel);
                })
                .appendTo($kopf);
        }
        $wurzel.append($kopf);
    },

    fuss: function ($wurzel, ctx, data) {
        if (data.fuss === false) return;
        $wurzel.append('<div class="fk-fuss"><span class="fk-punkt">verbunden</span><span class="fk-status"></span></div>');
    },

    /* ================================================================== Bogen */

    /**
     * Baut den Bogen in ein vorhandenes Element und liefert die Zeichenfunktion zurueck.
     * Wird sowohl vom eigenstaendigen Bogen-Widget als auch von der kompletten Kachel
     * benutzt - so gibt es nur eine Quelle fuer Geometrie und Bedienung.
     */
    bogenBauen: function ($ziel, ctx, data, gid) {
        var b = vis.binds.faikout;
        var VB_W = 320, VB_H = 258, CX = 160, CY = 152, R = 118, START = 145, SPAN = 250;
        var LAENGE = 2 * Math.PI * R * (SPAN / 360);
        var g = { min: b.MIN, max: b.MAX, step: b.SCHRITT };
        var entwurf = null; // waehrend des Ziehens angezeigter Wert

        var pkt = function (grad, r) {
            var w = grad * Math.PI / 180;
            return [CX + r * Math.cos(w), CY + r * Math.sin(w)];
        };
        var a0 = pkt(START, R), e0 = pkt(START + SPAN, R);
        var pfad = 'M ' + a0[0].toFixed(1) + ' ' + a0[1].toFixed(1) + ' A ' + R + ' ' + R +
            ' 0 1 1 ' + e0[0].toFixed(1) + ' ' + e0[1].toFixed(1);

        $ziel.append(
            '<div class="fk-instrument">' +
            ' <div class="fk-bogen">' +
            '  <svg viewBox="0 0 ' + VB_W + ' ' + VB_H + '">' +
            '   <defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="1" y2="0">' +
            '    <stop offset="0" stop-color="var(--fk-t0)"/><stop offset="0.22" stop-color="var(--fk-t1)"/>' +
            '    <stop offset="0.45" stop-color="var(--fk-t2)"/><stop offset="0.66" stop-color="var(--fk-t3)"/>' +
            '    <stop offset="0.85" stop-color="var(--fk-t4)"/><stop offset="1" stop-color="var(--fk-t5)"/>' +
            '   </linearGradient></defs>' +
            '   <path class="fk-spur" d="' + pfad + '" stroke="var(--fk-rand)"/>' +
            '   <path class="fk-skala" d="' + pfad + '" stroke="url(#' + gid + ')"/>' +
            '   <path class="fk-fuellung" d="' + pfad + '" stroke="url(#' + gid + ')" ' +
            '         stroke-dasharray="' + LAENGE.toFixed(1) + '" stroke-dashoffset="' + LAENGE.toFixed(1) + '"/>' +
            '   <line class="fk-raummarke" x1="0" y1="0" x2="0" y2="0"/>' +
            '   <g class="fk-griff"><circle r="11"/><circle class="fk-kern" r="4"/></g>' +
            '   <path class="fk-treffer" d="' + pfad + '"/>' +
            '  </svg>' +
            '  <div class="fk-ablesung">' +
            '   <div class="fk-soll"><span class="fk-soll-zahl">–</span><span class="fk-soll-einheit">°C</span></div>' +
            '   <div class="fk-soll-etikett">Soll</div>' +
            '   <div class="fk-ist">' +
            '    <span class="fk-ist-temp-feld">' + b.SYM.temp + '<b class="fk-ist-temp">–</b> °C</span>' +
            '    <span class="fk-ist-hum-feld">' + b.SYM.hum + '<b class="fk-ist-hum">–</b> %</span>' +
            '   </div>' +
            '  </div>' +
            ' </div>' +
            ' <div class="fk-pm-reihe">' +
            '  <button type="button" class="fk-pm fk-pm-minus" aria-label="Sollwert senken">−</button>' +
            '  <button type="button" class="fk-pm fk-pm-plus" aria-label="Sollwert erhöhen">+</button>' +
            ' </div>' +
            '</div>');

        var $wurzel = $ziel.closest('.fk');
        var $bogen = $ziel.find('.fk-bogen');

        var setzen = function (neu) {
            neu = Math.max(g.min, Math.min(g.max, Math.round(neu / g.step) * g.step));
            vis.setValue(ctx.oid('control.target'), neu);
            ctx.wartet($wurzel);
        };
        $ziel.find('.fk-pm-minus').on('click', function () {
            var a = parseFloat(ctx.wert('control.target'));
            if (!isNaN(a)) setzen(a - g.step);
        });
        $ziel.find('.fk-pm-plus').on('click', function () {
            var a = parseFloat(ctx.wert('control.target'));
            if (!isNaN(a)) setzen(a + g.step);
        });

        if (data.ziehen !== false) {
            var svg = $bogen.find('svg')[0];
            var treffer = $bogen.find('.fk-treffer')[0];
            var zieht = false;

            var ausEreignis = function (ev) {
                var r = svg.getBoundingClientRect();
                var x = (ev.clientX - r.left) / r.width * VB_W;
                var y = (ev.clientY - r.top) / r.height * VB_H;
                var d = Math.atan2(y - CY, x - CX) * 180 / Math.PI;
                if (d < 0) d += 360;
                var ende = START + SPAN - 360;           // Ende der Luecke unten
                if (d > ende && d < START) d = d < (ende + START) / 2 ? ende : START;
                if (d < START) d += 360;
                var t = g.min + ((d - START) / SPAN) * (g.max - g.min);
                return Math.max(g.min, Math.min(g.max, Math.round(t / g.step) * g.step));
            };

            treffer.addEventListener('pointerdown', function (ev) {
                zieht = true;
                $bogen.addClass('fk-zieht');
                treffer.setPointerCapture(ev.pointerId);
                entwurf = ausEreignis(ev);
                zeichnen();
                ev.preventDefault();
            });
            treffer.addEventListener('pointermove', function (ev) {
                if (!zieht) return;
                entwurf = ausEreignis(ev);
                zeichnen();
            });
            var los = function (ev) {
                if (!zieht) return;
                zieht = false;
                $bogen.removeClass('fk-zieht');
                try { treffer.releasePointerCapture(ev.pointerId); } catch (e) { /* schon frei */ }
                // Erst beim Loslassen senden - sonst laeuft je Mausbewegung ein Befehl.
                var wert = entwurf;
                entwurf = null;
                if (wert !== null) setzen(wert);
            };
            treffer.addEventListener('pointerup', los);
            treffer.addEventListener('pointercancel', los);
        }

        // Bereich und Schrittweite kommen vom Geraet (eine Anlage nimmt halbe Grad, die
        // andere nur ganze) - nachladen und dann neu zeichnen.
        b.grenzen(ctx, function (neu) { g = neu; zeichnen(); });

        function zeichnen() {
            var soll = entwurf !== null ? entwurf : parseFloat(ctx.wert('control.target'));
            if (soll !== null && !isNaN(soll)) {
                $ziel.find('.fk-soll-zahl').text(b.zahl(soll, 1));
                var anteil = Math.max(0, Math.min(1, (soll - g.min) / (g.max - g.min)));
                $ziel.find('.fk-fuellung').attr('stroke-dashoffset', String(LAENGE * (1 - anteil)));
                var gp = pkt(START + anteil * SPAN, R);
                $ziel.find('.fk-griff').attr('transform', 'translate(' + gp[0].toFixed(1) + ' ' + gp[1].toFixed(1) + ')');
            }

            // `temp` ist die Raumtemperatur, NICHT der Sollwert - der steht in `target`.
            var raum = parseFloat(ctx.wert('status.temp'));
            if (!isNaN(raum)) {
                $ziel.find('.fk-ist-temp').text(b.zahl(raum, 1));
                var rel = Math.max(0, Math.min(1, (raum - g.min) / (g.max - g.min)));
                var m1 = pkt(START + rel * SPAN, R + 13), m2 = pkt(START + rel * SPAN, R + 21);
                $ziel.find('.fk-raummarke')
                    .attr('x1', m1[0].toFixed(1)).attr('y1', m1[1].toFixed(1))
                    .attr('x2', m2[0].toFixed(1)).attr('y2', m2[1].toFixed(1));
            } else {
                $ziel.find('.fk-ist-temp-feld').hide();
            }

            // Luftfeuchte gibt es nur, wenn die Anlage wirklich eine misst.
            var f = parseFloat(ctx.wert('status.hum'));
            if (ctx.hat('status.hum') && !isNaN(f)) $ziel.find('.fk-ist-hum').text(b.zahl(f, 0));
            else $ziel.find('.fk-ist-hum-feld').hide();
        }
        return zeichnen;
    },

    bogen: function (widgetID, view, data) {
        vis.binds.faikout.start(widgetID, data, function ($wurzel, ctx) {
            var b = vis.binds.faikout;
            if (!ctx.hat('control.target')) return b.fehlt($wurzel, 'control.target');

            $wurzel.append('<div class="fk-streifen"></div>');
            b.kopf($wurzel, ctx, data);
            var zeichneBogen = b.bogenBauen($wurzel, ctx, data, 'fkskala_' + widgetID);
            b.fuss($wurzel, ctx, data);

            return function () {
                var an = ctx.hat('control.power') ? !!ctx.wert('control.power') : true;
                $wurzel.css('--fk-akzent', ctx.akzent()).toggleClass('fk-aus', !an);
                $wurzel.find('.fk-schalter').toggleClass('fk-an', an);
                zeichneBogen();
                var erreichbar = ctx.hat('info.online') ? !!ctx.wert('info.online') : true;
                $wurzel.find('.fk-punkt').toggleClass('fk-weg', !erreichbar).text(erreichbar ? 'verbunden' : 'offline');
            };
        });
    },
    /* ================================================================== Betriebsart */

    modus: function (widgetID, view, data, senkrecht) {
        vis.binds.faikout.start(widgetID, data, function ($wurzel, ctx) {
            var b = vis.binds.faikout;
            if (!ctx.hat('control.mode')) return b.fehlt($wurzel, 'control.mode');

            b.kopf($wurzel, ctx, data);
            var $g = $('<div class="fk-gruppe"></div>');
            if (data.etikett !== false) $g.append('<div class="fk-gruppe-etikett">Betriebsart</div>');
            var $p = $('<div class="fk-pillen"></div>').toggleClass('fk-senkrecht', !!senkrecht);
            b.MODI.forEach(function (m) {
                $('<button type="button" class="fk-pille"></button>')
                    .html((data.symbole === false ? '' : b.SYM[m.sym]) + '<span>' + m.text + '</span>')
                    .attr('data-wert', m.wert)
                    .on('click', function () {
                        vis.setValue(ctx.oid('control.mode'), m.wert);
                        // Eine Betriebsart zu waehlen heisst: die Anlage soll laufen.
                        if (ctx.hat('control.power') && !ctx.wert('control.power')) {
                            vis.setValue(ctx.oid('control.power'), true);
                        }
                        ctx.wartet($wurzel);
                    })
                    .appendTo($p);
            });
            $g.append($p);
            $wurzel.append($g);
            b.fuss($wurzel, ctx, data);

            return function () {
                var an = ctx.hat('control.power') ? !!ctx.wert('control.power') : true;
                var m = ctx.wert('control.mode');
                $wurzel.css('--fk-akzent', ctx.akzent()).toggleClass('fk-aus', !an);
                $wurzel.find('.fk-schalter').toggleClass('fk-an', an);
                $wurzel.find('.fk-pille').each(function () {
                    $(this).toggleClass('fk-gewaehlt', $(this).attr('data-wert') === m && an);
                });
            };
        });
    },

    /* ================================================================== Luefterstufe */

    luefter: function (widgetID, view, data, senkrecht) {
        vis.binds.faikout.start(widgetID, data, function ($wurzel, ctx) {
            var b = vis.binds.faikout;
            if (!ctx.hat('control.fan')) return b.fehlt($wurzel, 'control.fan');

            b.kopf($wurzel, ctx, data);
            var $g = $('<div class="fk-gruppe"></div>');
            if (data.etikett !== false) $g.append('<div class="fk-gruppe-etikett">Lüfter</div>');
            var $p = $('<div class="fk-pillen"></div>').toggleClass('fk-senkrecht', !!senkrecht);
            b.LUEFTER.forEach(function (l) {
                $('<button type="button" class="fk-pille fk-nur-text"></button>')
                    .text(l.text).attr('data-wert', l.wert)
                    .on('click', function () {
                        vis.setValue(ctx.oid('control.fan'), l.wert);
                        ctx.wartet($wurzel);
                    })
                    .appendTo($p);
            });
            $g.append($p);
            $wurzel.append($g);
            b.fuss($wurzel, ctx, data);

            return function () {
                var f = ctx.wert('control.fan');
                $wurzel.css('--fk-akzent', ctx.akzent());
                $wurzel.find('.fk-pille').each(function () {
                    $(this).toggleClass('fk-gewaehlt', $(this).attr('data-wert') === f);
                });
                $wurzel.find('.fk-schalter').toggleClass('fk-an', ctx.hat('control.power') ? !!ctx.wert('control.power') : true);
            };
        });
    },

    /* ================================================================== Leistungssteuerung */

    leistung: function (widgetID, view, data) {
        vis.binds.faikout.start(widgetID, data, function ($wurzel, ctx) {
            var b = vis.binds.faikout;
            if (!ctx.hat('control.demand')) return b.fehlt($wurzel, 'control.demand');

            b.kopf($wurzel, ctx, data);
            var $g = $('<div class="fk-gruppe"></div>');
            if (data.etikett !== false) $g.append('<div class="fk-gruppe-etikett">Leistungsbegrenzung</div>');
            $g.append(
                '<div class="fk-leistung">' +
                ' <div class="fk-leistung-wert"><span class="fk-leistung-zahl">–</span><small>%</small></div>' +
                ' <input type="range" class="fk-schieber" min="30" max="100" step="5" value="100">' +
                ' <div class="fk-leistung-skala"><span>30</span><span>65</span><span>100</span></div>' +
                '</div>');
            $wurzel.append($g);
            b.fuss($wurzel, ctx, data);

            var $s = $wurzel.find('.fk-schieber');
            // Waehrend des Schiebens nur anzeigen; gesendet wird beim Loslassen, sonst laeuft
            // je Rastung ein Befehl an die Anlage.
            $s.on('input', function () { $wurzel.find('.fk-leistung-zahl').text($s.val()); });
            $s.on('change', function () {
                vis.setValue(ctx.oid('control.demand'), parseInt($s.val(), 10));
                ctx.wartet($wurzel);
            });

            return function () {
                var w = parseInt(ctx.wert('control.demand'), 10);
                $wurzel.css('--fk-akzent', ctx.akzent());
                if (!isNaN(w)) {
                    if (!$s.is(':active')) $s.val(w);
                    $wurzel.find('.fk-leistung-zahl').text(w);
                }
            };
        });
    },

    /* ================================================================== Zusatzfunktionen */

    zusatz: function (widgetID, view, data, senkrecht) {
        vis.binds.faikout.start(widgetID, data, function ($wurzel, ctx) {
            var b = vis.binds.faikout;
            // `swing` und `swingv`/`swingh` sind zwei Wege zum selben Ziel: hat die Anlage die
            // getrennten Lamellen, ist das Sammel-Feld ueberfluessig und wuerde doppelt wirken.
            var getrennt = ctx.hat('control.swingv') || ctx.hat('control.swingh');
            var liste = b.ZUSATZ.filter(function (z) {
                if (z.feld === 'control.swing' && getrennt) return false;
                return ctx.hat(z.feld);
            });
            if (!liste.length) {
                $wurzel.append('<div class="fk-fehler">Dieses Gerät meldet keine der Zusatzfunktionen.</div>');
                return null;
            }

            b.kopf($wurzel, ctx, data);
            var $g = $('<div class="fk-gruppe"></div>');
            if (data.etikett !== false) $g.append('<div class="fk-gruppe-etikett">Zusatzfunktionen</div>');
            var $p = $('<div class="fk-pillen"></div>').toggleClass('fk-senkrecht', !!senkrecht);
            liste.forEach(function (z) {
                var mitText = data.beschriftung === true || senkrecht;
                $('<button type="button" class="fk-pille fk-schalt"></button>')
                    .addClass(mitText ? '' : 'fk-nur-icon')
                    .attr({ 'data-feld': z.feld, title: z.name, 'aria-label': z.name })
                    .html(b.SYM[z.sym] + (mitText ? '<span>' + z.name + '</span>' : ''))
                    .on('click', function () {
                        var alt = ctx.wert(z.feld);
                        // `swing` ist eine Liste (off/on), alle anderen sind Schalter.
                        // `swing` kennt off/on/V/H/H+V/C (SWING_* in Faikout.c). Umgeschaltet wird nur
                    // zwischen aus und ein; die Achsen setzt man ueber swingv/swingh.
                    if (z.feld === 'control.swing') vis.setValue(ctx.oid(z.feld), alt === 'off' ? 'on' : 'off');
                        else vis.setValue(ctx.oid(z.feld), !alt);
                        ctx.wartet($wurzel);
                    })
                    .appendTo($p);
            });
            $g.append($p);
            $wurzel.append($g);
            b.fuss($wurzel, ctx, data);

            return function () {
                $wurzel.css('--fk-akzent', ctx.akzent());
                $wurzel.find('.fk-schalt').each(function () {
                    var f = $(this).attr('data-feld');
                    var v = ctx.wert(f);
                    var an = f === 'control.swing' ? !!(v && v !== 'off') : !!v;
                    $(this).toggleClass('fk-gewaehlt', an);
                });
                $wurzel.find('.fk-schalter').toggleClass('fk-an', ctx.hat('control.power') ? !!ctx.wert('control.power') : true);
            };
        });
    },

    /* ================================================================== Messwerte */

    /** Welche Messwerte sollen erscheinen? Ohne Auswahl die sechs der Standardkachel. */
    gewaehlteWerte: function (data) {
        var b = vis.binds.faikout;
        var aus = b.MESSWERTE.filter(function (m) { return data['zeige_' + m.schluessel] === true; });
        if (aus.length) return aus;
        return b.MESSWERTE.filter(function (m) {
            return ['aussen', 'leistung', 'heute', 'verdichter', 'ventilator', 'kaeltemittel']
                .indexOf(m.schluessel) >= 0;
        });
    },

    messwerte: function (widgetID, view, data) {
        vis.binds.faikout.start(widgetID, data, function ($wurzel, ctx) {
            var b = vis.binds.faikout;
            b.kopf($wurzel, ctx, data);
            var liste = b.gewaehlteWerte(data).filter(function (m) { return ctx.hat(m.feld); });
            if (!liste.length) {
                $wurzel.append('<div class="fk-fehler">Keiner der gewählten Messwerte ist bei diesem Gerät vorhanden.</div>');
                return null;
            }
            $wurzel.append('<div class="fk-messwerte"></div>');
            b.fuss($wurzel, ctx, data);

            return function () {
                var html = '';
                liste.forEach(function (m) {
                    var v = b.zahl(ctx.wert(m.feld), m.stellen);
                    if (v === null) return;
                    html += '<div class="fk-mw"><div class="fk-mw-name">' + m.name + '</div>' +
                        '<div class="fk-mw-wert">' + v + '<small>' + m.einheit + '</small></div></div>';
                });
                $wurzel.find('.fk-messwerte').html(html);
                $wurzel.css('--fk-akzent', ctx.akzent());
            };
        });
    },

    einzelwert: function (widgetID, view, data) {
        vis.binds.faikout.start(widgetID, data, function ($wurzel, ctx) {
            var b = vis.binds.faikout;
            var m = null;
            for (var i = 0; i < b.MESSWERTE.length; i++) {
                if (b.MESSWERTE[i].schluessel === data.messwert) m = b.MESSWERTE[i];
            }
            if (!m) {
                $wurzel.html('<div class="fk-fehler">Kein Messwert gewählt.</div>');
                return null;
            }
            if (!ctx.hat(m.feld)) return b.fehlt($wurzel, m.feld);

            $wurzel.append(
                '<div class="fk-einzel">' +
                (data.etikett === false ? '' : '<div class="fk-einzel-name">' + (data.titel || m.name) + '</div>') +
                ' <div class="fk-einzel-wert">–<small>' + m.einheit + '</small></div>' +
                '</div>');

            return function () {
                var v = b.zahl(ctx.wert(m.feld), m.stellen);
                $wurzel.find('.fk-einzel-wert').html((v === null ? '–' : v) + '<small>' + m.einheit + '</small>');
                $wurzel.css('--fk-akzent', ctx.akzent());
            };
        });
    },

    /* ================================================================== Energieverlauf */

    /** Farben der drei Reihen. Kalt/warm sind gesetzt, Gesamt bleibt neutral dazwischen. */
    VERLAUF_FARBEN: { gesamt: '#a78bfa', kuehlen: '#4fc3f7', heizen: '#ff7043' },

    /**
     * Liest eine der drei Reihen aus dem Adapter.
     *
     * Alle drei fuehrt der Adapter selbst - Stunden, Tage und Monate. Es ist bewusst kein
     * Fremdskript noetig: sonst blieben Monats- und Jahresansicht bei jedem leer, der nichts
     * weiter einrichtet.
     *
     * @param {function} fertig  ([{beschriftung, kuehlen, heizen}], hinweis) => void
     */
    verlaufLesen: function (ctx, bereich, fertig) {
        var b = vis.binds.faikout;
        var FELD = { tag: 'stundenJson', monat: 'tageJson', jahr: 'monateJson' };
        var feld = FELD[bereich] || FELD.tag;

        // Kuehlen und Heizen stehen getrennt; sie werden ueber ihren Zeitschluessel vereint.
        var reihen = {};
        var offen = 2;
        var gefunden = false;

        ['kuehlen', 'heizen'].forEach(function (art) {
            var pfad = 'verbrauch.' + art + '.' + feld;
            if (!ctx.hat(pfad)) {
                if (!--offen) b.verlaufFertig(reihen, fertig, bereich, gefunden ? null : feld);
                return;
            }
            gefunden = true;
            vis.conn.getState(ctx.oid(pfad), function (err, zustand) {
                if (!err && zustand && zustand.val) {
                    try {
                        JSON.parse(zustand.val).forEach(function (p) {
                            // Der Adapter benennt den Schluessel je nach Reihe verschieden.
                            var k = p.stunde || p.tag || p.monat;
                            // Luecken tragen keinen Schluessel - sie gehoeren nicht ins Diagramm.
                            if (!k) return;
                            if (!reihen[k]) reihen[k] = { schluessel: k, kuehlen: 0, heizen: 0 };
                            reihen[k][art] = Number(p.kwh) || 0;
                        });
                    } catch (e) { /* unbrauchbares JSON wird still uebergangen */ }
                }
                if (!--offen) b.verlaufFertig(reihen, fertig, bereich, null);
            });
        });
    },

    verlaufFertig: function (reihen, fertig, bereich, fehlendesFeld) {
        var b = vis.binds.faikout;
        if (fehlendesFeld) return fertig(null, fehlendesFeld);
        var schluessel = Object.keys(reihen).sort();
        fertig(schluessel.map(function (k) {
            var e = reihen[k];
            return {
                beschriftung: b.verlaufBeschriftung(k, bereich),
                kuehlen: e.kuehlen,
                heizen: e.heizen
            };
        }));
    },

    /** Kurze Achsenbeschriftung: Stunde, Tag im Monat oder Monatsname. */
    verlaufBeschriftung: function (schluessel, bereich) {
        var MONATE = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
        if (bereich === 'tag') return schluessel.slice(-2);                      // 2026-08-19T14 -> 14
        if (/^\d{4}-\d{2}-\d{2}$/.test(schluessel)) return String(+schluessel.slice(8)) + '.';
        if (/^\d{4}-\d{2}$/.test(schluessel)) return MONATE[+schluessel.slice(5) - 1] || schluessel;
        return schluessel;
    },

    /** Zeichnet die Saeulen als SVG. Ohne Fremdbibliothek, damit das Widget eigenstaendig bleibt. */
    verlaufZeichnen: function ($ziel, punkte, arten, breite, hoehe) {
        var b = vis.binds.faikout;
        var LINKS = 34, UNTEN = 18, OBEN = 8, RECHTS = 4;
        var flaecheB = breite - LINKS - RECHTS;
        var flaecheH = hoehe - UNTEN - OBEN;

        // Gesamt liegt hinten, die Anteile stehen davor - so bleiben beide ablesbar.
        var reihen = [];
        if (arten.gesamt)  reihen.push({ art: 'gesamt',  werte: punkte.map(function (p) { return p.kuehlen + p.heizen; }) });
        if (arten.heizen)  reihen.push({ art: 'heizen',  werte: punkte.map(function (p) { return p.heizen; }) });
        if (arten.kuehlen) reihen.push({ art: 'kuehlen', werte: punkte.map(function (p) { return p.kuehlen; }) });

        var max = 0.1;
        reihen.forEach(function (r) { r.werte.forEach(function (v) { if (v > max) max = v; }); });
        // Auf eine glatte Stufe aufrunden, damit die Achse lesbare Zahlen traegt.
        var stufe = max <= 1 ? 0.25 : max <= 10 ? 2 : max <= 50 ? 10 : max <= 200 ? 50 : 100;
        var spitze = Math.ceil(max / stufe) * stufe;

        function y(v) { return OBEN + flaecheH - (v / spitze) * flaecheH; }
        var gruppeB = flaecheB / Math.max(punkte.length, 1);
        var balkenB = Math.max(2, gruppeB / Math.max(reihen.length, 1) - 1.5);

        var svg = '<svg viewBox="0 0 ' + breite + ' ' + hoehe + '" preserveAspectRatio="none" class="fk-verlauf-svg">';
        svg += '<g class="fk-v-raster">';
        for (var i = 0; i <= 2; i++) {
            svg += '<line x1="' + LINKS + '" y1="' + y(spitze * i / 2).toFixed(1) +
                   '" x2="' + (breite - RECHTS) + '" y2="' + y(spitze * i / 2).toFixed(1) + '"/>';
        }
        svg += '</g><g class="fk-v-achse">';
        for (var j = 0; j <= 2; j++) {
            var v = spitze * j / 2;
            var t = v >= 10 ? v.toFixed(0) : v.toFixed(v < 1 ? 2 : 1);
            svg += '<text x="' + (LINKS - 4) + '" y="' + (y(v) + 3).toFixed(1) + '" text-anchor="end">' + t + '</text>';
        }
        // Beschriftung ausduennen, sonst kleben 24 oder 31 Werte aneinander.
        var schritt = Math.ceil(punkte.length / 8) || 1;
        punkte.forEach(function (p, k) {
            if (k % schritt) return;
            svg += '<text x="' + (LINKS + gruppeB * (k + 0.5)).toFixed(1) + '" y="' + (hoehe - 5) +
                   '" text-anchor="middle">' + p.beschriftung + '</text>';
        });
        svg += '</g><g class="fk-v-balken">';
        reihen.forEach(function (r, ri) {
            r.werte.forEach(function (wert, k) {
                if (wert <= 0) return;
                var x = LINKS + gruppeB * k + (gruppeB - balkenB * reihen.length) / 2 + ri * balkenB;
                var h = Math.max(1, OBEN + flaecheH - y(wert));
                svg += '<rect x="' + x.toFixed(1) + '" y="' + y(wert).toFixed(1) +
                       '" width="' + balkenB.toFixed(1) + '" height="' + h.toFixed(1) +
                       '" rx="1" fill="' + b.VERLAUF_FARBEN[r.art] + '">' +
                       '<title>' + punkte[k].beschriftung + ' · Kühlen ' + punkte[k].kuehlen.toFixed(1) +
                       ' kWh · Heizen ' + punkte[k].heizen.toFixed(1) + ' kWh</title></rect>';
            });
        });
        svg += '</g></svg>';
        $ziel.html(svg);
    },

    verlauf: function (widgetID, view, data) {
        vis.binds.faikout.start(widgetID, data, function ($wurzel, ctx) {
            var b = vis.binds.faikout;
            b.kopf($wurzel, ctx, data);

            var bereich = data.bereich || 'tag';
            var arten = {
                gesamt:  data.zeige_gesamt === true,
                kuehlen: data.zeige_kuehlen !== false,
                heizen:  data.zeige_heizen !== false
            };
            var BESCHRIFTUNG = { tag: 'Heute', monat: 'Dieser Monat', jahr: 'Dieses Jahr' };

            var $box = $('<div class="fk-verlauf"></div>').appendTo($wurzel);
            if (data.umschalter !== false) {
                var $schalter = $('<div class="fk-v-schalter"></div>').appendTo($box);
                ['tag', 'monat', 'jahr'].forEach(function (wahl) {
                    $('<button type="button"></button>')
                        .text({ tag: 'Tag', monat: 'Monat', jahr: 'Jahr' }[wahl])
                        .attr('aria-pressed', wahl === bereich ? 'true' : 'false')
                        .on('click', function () {
                            bereich = wahl;
                            $schalter.find('button').attr('aria-pressed', 'false');
                            $(this).attr('aria-pressed', 'true');
                            laden();
                        })
                        .appendTo($schalter);
                });
            }
            if (data.auswahl !== false) {
                var $arten = $('<div class="fk-v-arten"></div>').appendTo($box);
                [['gesamt', 'Gesamt'], ['kuehlen', 'Kühlen'], ['heizen', 'Heizen']].forEach(function (paar) {
                    var $l = $('<label></label>').appendTo($arten);
                    $('<input type="checkbox">')
                        .prop('checked', arten[paar[0]])
                        .on('change', function () { arten[paar[0]] = this.checked; laden(); })
                        .appendTo($l);
                    $('<span class="fk-v-punkt"></span>')
                        .css('background', b.VERLAUF_FARBEN[paar[0]]).appendTo($l);
                    $l.append(document.createTextNode(paar[1]));
                });
            }
            var $flaeche = $('<div class="fk-v-flaeche"></div>').appendTo($box);
            var $fuss = $('<div class="fk-v-fuss"><span class="fk-v-zeitraum"></span>' +
                          '<span class="fk-v-summe"></span></div>').appendTo($box);
            b.fuss($wurzel, ctx, data);

            function laden() {
                b.verlaufLesen(ctx, bereich, function (punkte, fehlend) {
                    $fuss.find('.fk-v-zeitraum').text(BESCHRIFTUNG[bereich] || '');
                    if (punkte === null) {
                        $flaeche.html('<div class="fk-fehler">Dieses Gerät hat keinen Datenpunkt ' +
                            '<code>verbrauch.&lt;art&gt;.' + fehlend + '</code>. Er entsteht, sobald ' +
                            'die Anlage Energiewerte meldet.</div>');
                        $fuss.find('.fk-v-summe').text('');
                        return;
                    }
                    if (!punkte.length) {
                        $flaeche.html('<div class="fk-v-leer">Noch keine Werte für diesen Zeitraum.</div>');
                        $fuss.find('.fk-v-summe').text('');
                        return;
                    }
                    var w = $flaeche.width() || 400;
                    b.verlaufZeichnen($flaeche, punkte, arten, w, Math.max(110, Math.round(w * 0.42)));
                    var summe = punkte.reduce(function (a, p) { return a + p.kuehlen + p.heizen; }, 0);
                    $fuss.find('.fk-v-summe').html('Summe <b>' +
                        (summe >= 100 ? summe.toFixed(0) : summe.toFixed(1)) + ' kWh</b>');
                });
            }

            return function () {
                $wurzel.css('--fk-akzent', ctx.akzent());
                laden();
            };
        });
    },

    /* ================================================================== Komplette Kachel */

    kachel: function (widgetID, view, data) {
        vis.binds.faikout.start(widgetID, data, function ($wurzel, ctx) {
            var b = vis.binds.faikout;
            if (!ctx.hat('control.target')) return b.fehlt($wurzel, 'control.target');
            var teile = [];

            $wurzel.append('<div class="fk-streifen"></div>');
            b.kopf($wurzel, ctx, data);

            teile.push(b.bogenBauen($wurzel, ctx, data, 'fkskala_' + widgetID));
            if (ctx.hat('control.mode')) {
                teile.push(b.teilPillen($wurzel, ctx, 'Betriebsart', 'control.mode', b.MODI, false, data.symbole !== false));
            }
            if (ctx.hat('control.fan')) {
                teile.push(b.teilPillen($wurzel, ctx, 'Lüfter', 'control.fan', b.LUEFTER, true, false));
            }

            // Schwenken gehoert auf die grosse Kachel. Die uebrigen Zusatzfunktionen kommen
            // nur dazu, wenn das Attribut `zusatz` gesetzt ist - sonst wird die Kachel zu voll.
            var schalter = b.ZUSATZ.filter(function (z) {
                if (!ctx.hat(z.feld)) return false;
                // `swing` und `swingv`/`swingh` sind zwei Wege zum selben Ziel: hat die Anlage
                // die getrennten Lamellen, waere das Sammel-Feld doppelt.
                if (z.feld === 'control.swing' && (ctx.hat('control.swingv') || ctx.hat('control.swingh'))) return false;
                var istSchwenken = z.feld === 'control.swing' || z.feld === 'control.swingv' || z.feld === 'control.swingh';
                return istSchwenken || data.zusatz === true;
            });
            if (schalter.length) teile.push(b.teilSchalter($wurzel, ctx, schalter, data));

            teile.push(b.teilMesswerte($wurzel, ctx, data));
            b.fuss($wurzel, ctx, data);

            return function () {
                var an = ctx.hat('control.power') ? !!ctx.wert('control.power') : true;
                $wurzel.css('--fk-akzent', ctx.akzent()).toggleClass('fk-aus', !an);
                $wurzel.find('.fk-schalter').toggleClass('fk-an', an);
                teile.forEach(function (f) { if (f) f(); });
                var erreichbar = ctx.hat('info.online') ? !!ctx.wert('info.online') : true;
                $wurzel.find('.fk-punkt').toggleClass('fk-weg', !erreichbar).text(erreichbar ? 'verbunden' : 'offline');
            };
        });
    },

    /* --- Reihen der Kachel (ohne eigenen Rahmen und ohne Kopfzeile) --- */

    teilPillen: function ($wurzel, ctx, etikett, feld, liste, nurText, symbole) {
        var b = vis.binds.faikout;
        var $g = $('<div class="fk-gruppe" style="flex:none"></div>')
            .append('<div class="fk-gruppe-etikett">' + etikett + '</div>');
        var $p = $('<div class="fk-pillen"></div>');
        liste.forEach(function (e) {
            var $t = $('<button type="button" class="fk-pille"></button>').attr('data-wert', e.wert);
            if (nurText) $t.addClass('fk-nur-text').text(e.text);
            else $t.html((symbole ? b.SYM[e.sym] : '') + '<span>' + e.text + '</span>');
            $t.on('click', function () {
                vis.setValue(ctx.oid(feld), e.wert);
                if (feld === 'control.mode' && ctx.hat('control.power') && !ctx.wert('control.power')) {
                    vis.setValue(ctx.oid('control.power'), true);
                }
                ctx.wartet($wurzel);
            });
            $p.append($t);
        });
        $g.append($p);
        $wurzel.append($g);
        return function () {
            var w = ctx.wert(feld);
            var an = ctx.hat('control.power') ? !!ctx.wert('control.power') : true;
            $g.find('.fk-pille').each(function () {
                var passt = $(this).attr('data-wert') === w;
                $(this).toggleClass('fk-gewaehlt', feld === 'control.mode' ? (passt && an) : passt);
            });
        };
    },

    /** Reihe mit Symbolschaltern (Schwenken, Sparen, Turbo …) fuer die grosse Kachel. */
    teilSchalter: function ($wurzel, ctx, liste, data) {
        var b = vis.binds.faikout;
        var $g = $('<div class="fk-gruppe" style="flex:none"></div>')
            .append('<div class="fk-gruppe-etikett">' +
                (liste.length > 3 ? 'Zusatzfunktionen' : 'Schwenken') + '</div>');
        var $p = $('<div class="fk-pillen"></div>');
        liste.forEach(function (z) {
            var mitText = data && data.beschriftung === true;
            $('<button type="button" class="fk-pille fk-schalt"></button>')
                .addClass(mitText ? '' : 'fk-nur-icon')
                .attr({ 'data-feld': z.feld, title: z.name, 'aria-label': z.name })
                .html(b.SYM[z.sym] + (mitText ? '<span>' + z.name + '</span>' : ''))
                .on('click', function () {
                    var alt = ctx.wert(z.feld);
                    // `swing` kennt off/on/V/H/H+V/C (SWING_* in Faikout.c). Umgeschaltet wird nur
                    // zwischen aus und ein; die Achsen setzt man ueber swingv/swingh.
                    if (z.feld === 'control.swing') vis.setValue(ctx.oid(z.feld), alt === 'off' ? 'on' : 'off');
                    else vis.setValue(ctx.oid(z.feld), !alt);
                    ctx.wartet($wurzel);
                })
                .appendTo($p);
        });
        $g.append($p);
        $wurzel.append($g);
        return function () {
            $g.find('.fk-schalt').each(function () {
                var f = $(this).attr('data-feld');
                var v = ctx.wert(f);
                $(this).toggleClass('fk-gewaehlt', f === 'control.swing' ? !!(v && v !== 'off') : !!v);
            });
        };
    },

    teilMesswerte: function ($wurzel, ctx, data) {
        var b = vis.binds.faikout;
        var liste = b.gewaehlteWerte(data).filter(function (m) { return ctx.hat(m.feld); });
        if (!liste.length) return null;
        var $m = $('<div class="fk-messwerte" style="flex:none;border-top:1px solid var(--fk-rand)"></div>');
        $wurzel.append($m);
        return function () {
            var html = '';
            liste.forEach(function (m) {
                var v = b.zahl(ctx.wert(m.feld), m.stellen);
                if (v === null) return;
                html += '<div class="fk-mw"><div class="fk-mw-name">' + m.name + '</div>' +
                    '<div class="fk-mw-wert">' + v + '<small>' + m.einheit + '</small></div></div>';
            });
            $m.html(html);
        };
    }
};
