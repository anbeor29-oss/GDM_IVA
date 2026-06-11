'use strict';
const forge  = require('node-forge');
const crypto = require('crypto');
const axios  = require('axios');
const { registerSATInvalidator, log } = require('../security/attackHandler');

const AUTH_URL    = 'https://cfdidescargamasivasolicitud.clouda.sat.gob.mx/Autenticacion/Autenticacion.svc';
const SOAP_ACTION = '"http://DescargaMasivaTerceros.gob.mx/IAutenticacion/Autentica"';

let _currentToken = null;
let _tokenExpiry  = null;

registerSATInvalidator(() => {
  _currentToken = null;
  _tokenExpiry  = null;
  log('Token SAT eliminado de memoria por seguridad');
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function nospaces(xml) {
  return xml.replace(/>\s+</g, '><').replace(/^\s+|\s+$/g, '').trim();
}

function generateUUID() {
  const h = crypto.createHash('md5').update(crypto.randomUUID()).digest('hex');
  return `uuid-${h.slice(0,8)}-${h.slice(4,8)}-${h.slice(4,12)}-${h.slice(4,16)}-${h.slice(20)}-1`;
}

// ── Cargar e-firma ────────────────────────────────────────────────────────────
function loadEFirma(cerPath, keyPath, password) {
  const fs = require('fs');

  const cerDer = fs.readFileSync(cerPath);
  const cerAsn1 = forge.asn1.fromDer(forge.util.createBuffer(cerDer));
  const certificate = forge.pki.certificateFromAsn1(cerAsn1);
  const cerB64 = cerDer.toString('base64');

  const keyDer = fs.readFileSync(keyPath);
  const keyB64 = keyDer.toString('base64');
  const keyPem = `-----BEGIN ENCRYPTED PRIVATE KEY-----\n${keyB64.match(/.{1,64}/g).join('\n')}\n-----END ENCRYPTED PRIVATE KEY-----`;
  const privateKey = forge.pki.decryptRsaPrivateKey(keyPem, password);
  if (!privateKey) throw new Error('No se pudo descifrar la llave privada. Contraseña incorrecta.');

  return { certificate, privateKey, cerB64 };
}

// ── Construir SOAP de autenticación ───────────────────────────────────────────
// Formato exacto requerido por el SAT (basado en @nodecfdi/sat-ws-descarga-masiva)
function buildAuthSoap(privateKey, cerB64) {
  const now     = new Date();
  const created = now.toISOString().replace(/\.\d{3}Z$/, '.000Z');
  const expires = new Date(now.getTime() + 5 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, '.000Z');
  const uuid    = generateUUID();

  // 1. Timestamp a firmar (con namespace propio para canonicalización)
  const timestampXml = nospaces(`
    <u:Timestamp xmlns:u="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd" u:Id="_0">
      <u:Created>${created}</u:Created>
      <u:Expires>${expires}</u:Expires>
    </u:Timestamp>
  `);

  // 2. SHA1 digest del Timestamp
  const digest = crypto.createHash('sha1').update(timestampXml).digest('base64');

  // 3. SignedInfo con el digest
  const signedInfoXml = nospaces(`
    <SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">
      <CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></CanonicalizationMethod>
      <SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"></SignatureMethod>
      <Reference URI="#_0">
        <Transforms>
          <Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></Transform>
        </Transforms>
        <DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"></DigestMethod>
        <DigestValue>${digest}</DigestValue>
      </Reference>
    </SignedInfo>
  `);

  // 4. Firmar SignedInfo con RSA-SHA1
  const md = forge.md.sha1.create();
  md.update(signedInfoXml, 'utf8');
  const sigValue = forge.util.encode64(privateKey.sign(md));

  // 5. SignedInfo sin xmlns para el XML final
  const signedInfoFinal = signedInfoXml.replace(
    '<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">',
    '<SignedInfo>'
  );

  // 6. Armar SOAP completo (una sola línea, sin espacios extras)
  return nospaces(`
    <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
                xmlns:u="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">
      <s:Header>
        <o:Security xmlns:o="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"
                    s:mustUnderstand="1">
          <u:Timestamp u:Id="_0">
            <u:Created>${created}</u:Created>
            <u:Expires>${expires}</u:Expires>
          </u:Timestamp>
          <o:BinarySecurityToken
            u:Id="${uuid}"
            ValueType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3"
            EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">
            ${cerB64}
          </o:BinarySecurityToken>
          <Signature xmlns="http://www.w3.org/2000/09/xmldsig#">
            ${signedInfoFinal}
            <SignatureValue>${sigValue}</SignatureValue>
            <KeyInfo>
              <o:SecurityTokenReference>
                <o:Reference URI="#${uuid}"
                  ValueType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3"/>
              </o:SecurityTokenReference>
            </KeyInfo>
          </Signature>
        </o:Security>
      </s:Header>
      <s:Body>
        <Autentica xmlns="http://DescargaMasivaTerceros.gob.mx"/>
      </s:Body>
    </s:Envelope>
  `);
}

// ── Autenticar contra el SAT ──────────────────────────────────────────────────
async function authenticate(cerPath, keyPath, password) {
  if (_currentToken && _tokenExpiry && Date.now() < _tokenExpiry) {
    return _currentToken;
  }

  log('Autenticando con el SAT...');
  const { privateKey, cerB64 } = loadEFirma(cerPath, keyPath, password);
  const soapBody = buildAuthSoap(privateKey, cerB64);

  const response = await axios.post(AUTH_URL, soapBody, {
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      'SOAPAction': SOAP_ACTION
    },
    timeout: 30000
  });

  const match = response.data.match(/<AutenticaResult>([\s\S]*?)<\/AutenticaResult>/);
  if (!match) throw new Error('SAT no retornó token. Respuesta: ' + response.data.substring(0, 400));

  _currentToken = match[1].trim();
  _tokenExpiry  = Date.now() + 4.5 * 60 * 1000;
  log('Autenticación SAT exitosa');
  return _currentToken;
}

function getToken()  { return _currentToken; }
function clearToken() { _currentToken = null; _tokenExpiry = null; }

module.exports = { authenticate, loadEFirma, getToken, clearToken };
