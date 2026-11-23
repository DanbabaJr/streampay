/**
 * Spanish catalog. Typed against `MessageKey`, so this file cannot gain a key
 * English does not have, and cannot drop one, without `tsc` failing.
 *
 * Placeholder names must match English exactly (lib/i18n/catalog.spec.ts diffs
 * them per key and fails the test run on drift); word order and grammar may
 * differ freely, which is the whole point of ICU over string concatenation.
 *
 * Glossary (see the PR description):
 *   stream → stream (borrowed technical term), streams → streams
 *   wallet → billetera, claim → reclamar, withdraw → retirar
 *   deposit → depósito, payer → pagador, payee/recipient → beneficiario
 *   network → red, contract → contrato, on-chain → on-chain
 * Amounts use Spanish conventions: decimal comma, dot grouping (`es` in Intl).
 */

import type { MessageKey } from "./en";

export const es: Record<MessageKey, string> = {
  "brand.name": "StreamPay",
  "brand.tagline": "Pagos en streaming sobre Stellar",
  "brand.footer": "StreamPay • Pagos continuos en streaming para la red Stellar",

  "chrome.skipToContent": "Saltar al contenido principal",
  "chrome.networkLive": "● Stellar {network}",
  "chrome.localeLabel": "Idioma",
  "chrome.networkText": "Stellar {network}",
  "chrome.contractLabel": "contrato {shortId}",
  "chrome.contractAria": "ID del contrato de streaming {contractId} — abre el explorador de bloques",
  "chrome.contractUnset": "ID de contrato no configurado",
  "chrome.walletOnNetwork": "La billetera está en {network}",
  "chrome.appSignsFor": "Esta aplicación firma para {network}.",
  "chrome.mismatchBody": "Las transacciones fallarán hasta que la billetera coincida.",
  "chrome.dismissWarning": "Descartar advertencia de red",
  "chrome.dashboard": "Panel",
  "chrome.backToDashboard": "Volver al panel",
  "chrome.goToAppHome": "Ir al inicio de la aplicación",
  "chrome.apiDocs": "Documentación de API ↗",
  "chrome.simulatorLink": "Simulador de acumulación →",

  "settings.navigation": "Ajustes",
  "settings.title": "Ajustes",
  "settings.description": "Gestiona notificaciones, webhooks y preferencias de telemetría del navegador.",
  "settings.notifications": "Notificaciones",
  "settings.webhooks": "Webhooks",
  "settings.telemetry": "Telemetría",
  "telemetry.title": "Telemetría y trazado",
  "telemetry.description": "Elige si este navegador exporta trazas de diagnóstico. La elección se aplica de inmediato y se guarda en este dispositivo.",
  "telemetry.scope": "Esta preferencia controla las trazas del lado del navegador y las solicitudes de correlación de transacciones. El trazado del lado del servidor lo gestiona el despliegue.",
  "telemetry.statusEnabled": "La telemetría está activada.",
  "telemetry.statusDisabled": "La telemetría está desactivada.",
  "telemetry.toggleLabel": "Permitir telemetría de diagnóstico",
  "telemetry.toggleHelp": "Cuando está desactivada, este navegador deja de exportar spans y datos de correlación de transacciones.",
  "telemetry.collectedTitle": "Qué contiene la telemetría",
  "telemetry.spans": "Los spans de traza pueden incluir nombres y tipos de operación, estado de éxito o error, marcas de tiempo y duración, IDs de traza y span generados, relaciones de padre y enlace, nombre y versión del servicio de la aplicación, nombres de eventos y atributos saneados.",
  "telemetry.correlation": "Tras una transacción, los datos de correlación pueden incluir su hash, el contexto de traza y un ID de stream opcional. Se envían al indexador configurado para que un evento de ledger posterior pueda enlazarse con su traza del navegador.",
  "telemetry.destinations": "Los spans completados se envían al recolector OTLP HTTP configurado por NEXT_PUBLIC_OTEL_EXPORTER_OTLP_ENDPOINT (por defecto: http://localhost:4318/v1/traces). Los datos de correlación se envían al indexador configurado por NEXT_PUBLIC_INDEXER_URL (por defecto: http://localhost:8787).",
  "telemetry.privacyTitle": "Filtrado y límites",
  "telemetry.privacy": "Los atributos de telemetría omiten los campos llamados amount, balance, deposit o withdrawn. Los campos de dirección se reducen a un prefijo de 8 caracteres; las URL de webhook se reducen a su origen; las direcciones de correo solo exponen el dominio; y los ID de Telegram solo exponen los últimos cuatro caracteres. Los patrones de clave secreta y los tokens bearer se redactan del texto de error. Otros nombres de diagnóstico y detalles de error pueden seguir incluyéndose, así que evita introducir información sensible en ellos.",
  "telemetry.storage": "Esta elección se guarda en localStorage bajo streampay:telemetryConsent. Sin una elección guardada, la telemetría permanece activada, igual que el valor por defecto anterior.",

  "home.kicker": "SOROBAN · STELLAR",
  "home.title": "⚡ StreamPay",
  "home.settings": "Ajustes",
  "home.browse": "Explorar el directorio →",
  "home.unitsWord": "unidades",
  "home.tagline":
    "Streams de pago continuos por segundo: nóminas, vesting, suscripciones. Conecta Freighter para empezar.",
  "home.connect": "Conectar Freighter",
  "home.connectedLabel": "Conectado:",
  "home.connectedAs": "Conectado: {address}",
  "home.fetchById": "Buscar stream por ID",
  "home.streamIdPlaceholder": "ID del stream",
  "home.fetch": "Buscar stream",
  "home.fetching": "Buscando…",
  "home.yourStreams": "Tus streams",
  "home.discoverOnchain": "Descubrir on-chain",
  "home.discovered":
    "{count, plural, =0 {No se encontró ningún stream} one {Se encontró # stream} other {Se encontraron # streams}} on-chain.",
  "home.streamLoaded": "Stream #{id} cargado.",
  "home.streamNotFound": "Stream no encontrado. Comprueba el ID e inténtalo de nuevo.",
  "home.enterStreamId": "Introduce un ID de stream.",
  "home.created": "Stream #{id} creado.",
  "home.batchCreated":
    "{count, plural, one {# stream creado} other {# streams creados}}: {ids}.",
  "home.withdrew": "Se retiraron {amount} del stream #{id}.",
  "home.claimed": "Se reclamaron {amount} del stream #{id}.",
  "home.toppedUp": "Stream #{id} recargado con {amount}.",
  "home.cancelled": "Stream #{id} cancelado.",
  "home.walletMissing": "Freighter no detectado: instala la extensión y vuelve a cargar.",
  "home.walletNoAddress": "Freighter no devolvió ninguna dirección.",
  "home.walletFailed": "Error al conectar la billetera: {reason}",

  "empty.dashboard.title": "Aún no hay streams",
  "empty.dashboard.body":
    "Tus streams de pago aparecerán aquí. Crea tu primer stream arriba o explora el directorio.",
  "empty.dashboard.action": "Explorar el directorio",
  "empty.listings.title": "No se encontraron listados",
  "empty.listings.body":
    "Aún no hay streams públicos que coincidan con los filtros actuales. Los listados permanecen ocultos hasta que suficientes streams compartan las mismas bandas; activa arriba «Mostrar streams con baja anonimidad» para ver los raros.",
  "empty.listings.action": "Crear un stream",
  "empty.analytics.title": "No hay streams que analizar",
  "empty.analytics.body":
    "Introduce una dirección de Stellar arriba o crea tu primer stream para ver el historial de acumulación y las previsiones de ingresos.",
  "empty.analytics.action": "Crear un stream",

  "pay.loading.title": "Resolviendo el enlace de pago",
  "pay.loading.body": "Verificando el compromiso criptográfico en Stellar Soroban…",
  "pay.invalid.title": "Enlace de pago no válido",
  "pay.invalid.body":
    "Esta referencia de enlace de pago está mal formada, dañada o ha caducado.",
  "pay.invoice.kicker": "Factura del enlace de pago",
  "pay.invoice.title": "Stream #{id}",
  "pay.invoice.active": "Stream activo",
  "pay.invoice.availableLabel": "Disponible para reclamar ahora mismo",
  "pay.invoice.streaming": "Transmitiendo linealmente en tiempo real",
  "pay.invoice.progress": "Progreso: {percent}",
  "pay.invoice.total": "Total: {amount} {unit, select, tokens {Tokens} other {unidades}}",
  "pay.invoice.unit.tokens": "Tokens",
  "pay.invoice.payer": "Pagador (emisor)",
  "pay.invoice.payee": "Beneficiario (receptor)",
  "pay.invoice.payeeProtected": "🔒 Vinculación ofuscada protegida",
  "pay.invoice.token": "Contrato del token",
  "pay.invoice.alreadyClaimed": "Ya reclamado",
  "pay.invoice.endTime": "Hora de fin",
  "pay.wallet.connected": "Billetera conectada",
  "pay.wallet.verified": "✓ Beneficiario verificado",
  "pay.wallet.mismatch": "✕ El beneficiario no coincide",
  "pay.error.heading": "Problema de verificación o reclamación",
  "pay.error.noWallet":
    "Billetera Freighter no detectada. Instala Freighter para reclamar.",
  "pay.error.rejected": "Autorización de la billetera rechazada.",
  "pay.error.bindingMismatch":
    "La billetera conectada no coincide con la vinculación ofuscada del beneficiario de este stream.",
  "pay.action.connectAndClaim": "Conectar Freighter y reclamar",
  "pay.action.claiming": "Enviando la reclamación a Stellar…",
  "pay.action.claim": "Reclamar {amount} Tokens",
  "pay.action.switchAccount": "Cambiar de cuenta (el beneficiario no coincide)",
  "pay.action.nothingToClaim": "No hay fondos acumulados para reclamar",
  "pay.note":
    "No se requiere contraseña ni crear una cuenta. Protegido por contratos inteligentes de Stellar Soroban.",
  "pay.terminal.cancelledTitle": "Stream cancelado",
  "pay.terminal.depletedTitle": "Stream agotado",
  "pay.terminal.completedTitle": "Stream completado",
  "pay.terminal.cancelledBody":
    "Este stream de pago se canceló on-chain. El escrow restante se dividió y se reembolsó.",
  "pay.terminal.depletedBody":
    "El beneficiario ya ha reclamado todos los tokens bloqueados en este stream.",
  "pay.terminal.completedBody":
    "Este stream ha concluido y no queda ningún saldo sin cobrar.",
  "pay.terminal.streamId": "ID del stream",
  "pay.terminal.totalFunded": "Total financiado",
  "pay.terminal.totalWithdrawn": "Total retirado",
  "pay.terminal.status": "Estado",
  "pay.receipt.title": "Fondos reclamados correctamente",
  "pay.receipt.body":
    "Los fondos acumulados de tu stream se han transferido directamente a tu billetera en Stellar.",
  "pay.receipt.claimedAmount": "Importe reclamado",
  "pay.receipt.recipientWallet": "Billetera del beneficiario",
  "pay.receipt.txHash": "Hash de la transacción",
  "pay.receipt.explorer": "Ver en Stellar Expert ↗",

  "meta.pay.notFound.title": "StreamPay — Enlace de pago no encontrado",
  "meta.pay.notFound.description":
    "Esta referencia de enlace de pago de StreamPay no es válida o no se pudo resolver on-chain.",
  "meta.pay.notFound.ogTitle": "StreamPay — Enlace de pago no válido",
  "meta.pay.notFound.ogDescription": "Referencia de stream no válida o caducada.",
  "meta.pay.status.active": "Stream activo",
  "meta.pay.status.cancelled": "Stream cancelado",
  "meta.pay.status.depleted": "Stream totalmente reclamado",
  "meta.pay.status.completed": "Stream completado",
  "meta.pay.title": "{status} · {amount} {unit} | {brand}",
  "meta.pay.description":
    "Pago continuo en streaming sobre Stellar (Soroban). Depósito total: {amount} {unit}. Abre este enlace para conectar una billetera y reclamar los fondos acumulados.",

  "form.depositLabel": "Depósito (unidades más pequeñas)",
  "form.depositHint":
    "Importe total a bloquear en el stream, en la unidad más pequeña del token (stroops para XLM, 7 decimales).",
  "form.durationLabel": "Duración (días)",
  "form.recipientLabel": "Beneficiario",
  "form.required": "obligatorio",
  "form.heading": "Crear un stream",
  "form.srDescription":
    "Rellena los campos siguientes para crear un stream de pago por segundo en Stellar. Los campos obligatorios están marcados con un asterisco (*).",
  "form.tokenLabel": "ID del contrato del token",
  "form.tokenPlaceholder": "C… (ID del Stellar Asset Contract del activo)",
  "form.tokenHint":
    "Introduce el ID del Stellar Asset Contract (SAC) del token que quieres transmitir. Empieza por la letra C.",
  "form.recipientHint": "Introduce la clave pública (dirección G…) del beneficiario del stream.",
  "form.nativeContractNote": "XLM nativo se transmite a través de su Stellar Asset Contract: {contractId}",
  "form.asset": "Activo",
  "form.assetNative": "XLM nativo",
  "form.assetContract": "Contrato de token (estilo USDC)",
  "form.cancelableLabel": "¿El beneficiario puede cancelar?",
  "form.yes": "Sí (cancelable)",
  "form.no": "No (solo el emisor)",
  "form.submit": "Crear stream",
  "form.submitting": "Creando el stream…",
  "form.preview.aria": "Vista previa del stream",
  "form.preview.title": "Vista previa del stream",
  "form.preview.totalDeposit": "Depósito total",
  "form.preview.dailyRate": "Tasa de flujo diaria",
  "form.preview.perSecondRate": "Tasa por segundo",
  "form.unitPerDay": "/día",
  "form.unitPerSecond": "/s",
  "form.amountsNote":
    "Los importes están en la unidad más pequeña ({decimals, number} decimales para {code}). La interfaz comprueba primero la autorización del token y solo pide a Freighter que apruebe el depósito cuando falta: espera una o dos firmas.",
  "form.policyHeading": "Límites de política activos:",
  "form.policyMinDeposit": "Depósito mínimo",
  "form.policyMinDuration": "Duración mínima",
  "form.policyMaxDuration": "Duración máxima",
  "form.policyMinRate": "Tasa mínima",
  "form.policyMaxRate": "Tasa máxima",
  "form.policyDepositLow": "El depósito está por debajo del límite de política de {min} unidades.",
  "form.policyDurationLow": "La duración ({actual, number}s) está por debajo del mínimo de política de {min, number}s.",
  "form.policyDurationHigh": "La duración ({actual, number}s) supera el máximo de política de {max, number}s.",
  "form.policyRateLow": "La tasa de acumulación ({rate}/s) está por debajo del mínimo de política de {min}/s.",
  "form.policyRateHigh": "La tasa de acumulación ({rate}/s) supera el máximo de política de {max}/s.",
  "form.amountEmpty": "Introduce un importe.",
  "form.amountNegative": "El importe debe ser mayor que cero.",
  "form.amountAmbiguous":
    "Los separadores de «{input}» son ambiguos. Usa {group} entre grupos de tres dígitos y {decimal} como máximo una vez.",
  "form.amountGroupedOnly":
    "Usa solo dígitos, opcionalmente con {separator} como separador de miles.",
  "form.amountTooPrecise":
    "Este token tiene como máximo {decimals, number} decimales: el importe que escribiste tendría que redondearse.",
  "form.amountInvalid": "Ese importe no se puede leer.",

  "form.recipientRequired": "Introduce una dirección de beneficiario.",
  "form.recipientInvalid":
    "Introduce una dirección de Stellar válida (G… con una suma de comprobación válida).",
  "form.tokenRequired": "Introduce un ID de contrato de token.",
  "form.tokenInvalid":
    "Introduce un ID de contrato de token válido (C… con una suma de comprobación válida).",
  "form.durationInvalid":
    "Introduce una duración en días mayor que cero (hasta 36.500 días).",
  "form.durationTooLong":
    "La duración supera el máximo del protocolo de {max, number} segundos.",
  "form.depositTooSmallForDuration":
    "El depósito es demasiado pequeño para esta duración: se necesitan al menos {min} para que el stream acumule.",
  "form.depositTooLarge":
    "El depósito es demasiado grande para esta duración: reduce el depósito o acorta la duración.",
  "form.depositTransferFailed":
    "No se pudo tomar el depósito: comprueba tu saldo y la autorización del token para el depósito más la comisión.",
  "form.recipientPayoutFailed":
    "No se pudo pagar al beneficiario: comprueba que la dirección tenga una trustline válida y esté autorizada.",
  "form.assetNotAllowed":
    "Este token no está en la lista de permitidos de la política de gobernanza.",
  "form.batchEmpty": "Añade al menos una fila del CSV.",
  "form.batchTooLarge": "El lote tiene demasiadas filas (máximo {max, number}).",
  "form.batchRowIssue": "Fila {row, number}: {detail}",

  "notFound.notFound": "No encontrado",
  "notFound.badRequest": "Problema en la solicitud",
  "notFound.stream.title": "Stream no encontrado",
  "notFound.stream.lookedFor": "Hemos buscado el ID del stream en esta URL.",
  "notFound.stream.why":
    "No existe ningún stream con ese ID en esta red. Puede que nunca se haya creado o que el enlace esté incompleto.",
  "notFound.stream.next":
    "Comprueba el ID del stream o vuelve al panel y ábrelo desde tu lista de streams.",
  "notFound.stream.malformedTitle": "ID de stream no válido",
  "notFound.stream.malformedBody":
    "«{id}» no es un ID de stream válido. Los ID de stream son números enteros.",
  "notFound.address.title": "Dirección no encontrada",
  "notFound.address.lookedFor": "Hemos buscado la dirección de Stellar en esta URL.",
  "notFound.address.why":
    "Esta dirección no ha creado ni recibido ningún stream de pagos en esta red.",
  "notFound.address.next":
    "Comprueba si hay errores en la dirección o empieza desde el panel y abre tus propios streams.",
  "notFound.address.malformedTitle": "Dirección no válida",
  "notFound.address.malformedBody":
    "«{address}» no es una dirección de Stellar válida. Debe ser una clave pública de 56 caracteres que empiece por G.",
  "notFound.pay.title": "Enlace de pago no encontrado",
  "notFound.pay.lookedFor": "Hemos buscado la referencia de pago en este enlace.",
  "notFound.pay.why":
    "Este enlace es desconocido. Puede que se haya escrito mal o esté truncado.",
  "notFound.pay.next":
    "Pide al pagador que vuelva a enviarte el enlace o abre el panel.",
  "notFound.pay.malformedTitle": "Enlace de pago no válido",
  "notFound.pay.malformedBody": "Este enlace de pago está mal formado o dañado.",

  "share.heading": "Comparte este enlace de pago",
  "share.body":
    "Escanea el código QR o copia el enlace. La referencia se genera en tu navegador y nunca se envía a terceros.",
  "share.qrLabel": "Código QR de este enlace de pago",
  "share.copy": "Copiar enlace",
  "share.copyLabel": "Copiar el enlace de pago al portapapeles",
  "share.copied": "Enlace de pago copiado al portapapeles.",
  "share.copiedButton": "¡Copiado!",
  "share.copyFailed":
    "No se pudo copiar el enlace. Selecciónalo y cópialo manualmente.",
};
