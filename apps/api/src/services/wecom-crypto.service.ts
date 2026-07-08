// @ts-nocheck
import { createDecipheriv, createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
const xmlParser = new XMLParser({
    ignoreAttributes: false,
    trimValues: false
});
function sha1(...args) {
    // 企业微信签名要求先字典序排序再 SHA1，顺序不一致会导致后台 URL 验证失败。
    return createHash('sha1').update(args.sort().join('')).digest('hex');
}
function pkcs7Unpad(buffer) {
    let pad = buffer[buffer.length - 1];
    if (pad < 1 || pad > 32) {
        pad = 0;
    }
    return buffer.subarray(0, buffer.length - pad);
}
function getAesKey(encodingAESKey) {
    if (!encodingAESKey || encodingAESKey.length !== 43) {
        throw new Error('EncodingAESKey 长度必须是 43 位');
    }
    return Buffer.from(`${encodingAESKey}=`, 'base64');
}
// 解密企业微信加密文本。
// 企业微信使用 AES-256-CBC + PKCS7，且明文末尾带 CorpID，必须校验后才能进入业务链路。
function decryptText(input) {
    const aesKey = getAesKey(input.encodingAESKey);
    const iv = aesKey.subarray(0, 16);
    const decipher = createDecipheriv('aes-256-cbc', aesKey, iv);
    decipher.setAutoPadding(false);
    const encryptedBuffer = Buffer.from(input.encryptedText, 'base64');
    const decrypted = Buffer.concat([decipher.update(encryptedBuffer), decipher.final()]);
    const plainBuffer = pkcs7Unpad(decrypted);
    // 企业微信明文结构为：16 字节随机串 + 4 字节消息长度 + XML 明文 + CorpID。
    // 这里校验 CorpID，避免别的企业回调被误处理进本系统。
    const msgLength = plainBuffer.readUInt32BE(16);
    const msgStart = 20;
    const msgEnd = msgStart + msgLength;
    const msg = plainBuffer.subarray(msgStart, msgEnd).toString('utf8');
    const receiveId = plainBuffer.subarray(msgEnd).toString('utf8');
    if (input.corpId && receiveId && receiveId !== input.corpId) {
        throw new Error(`CorpID 校验失败：解密得到 ${receiveId}，但当前配置为 ${input.corpId}`);
    }
    return msg;
}
export function verifyWeComUrl(input) {
    // 企业微信后台保存回调地址前会发 GET 验证。
    // 只有签名和 CorpID 都通过时才返回解密后的 echostr，避免错误配置被误认为可用。
    if (!input.token || !input.encodingAESKey || !input.corpId) {
        throw new Error('企业微信 token / encodingAESKey / corpId 不能为空');
    }
    if (!input.msgSignature || !input.timestamp || !input.nonce || !input.echostr) {
        throw new Error('企业微信 URL 验证参数缺失');
    }
    const signature = sha1(input.token, input.timestamp, input.nonce, input.echostr);
    if (signature !== input.msgSignature) {
        throw new Error(`企业微信 URL 签名校验失败：计算得到 ${signature}，传入 ${input.msgSignature}`);
    }
    return decryptText({
        encodingAESKey: input.encodingAESKey,
        encryptedText: input.echostr,
        corpId: input.corpId
    });
}
export function decryptWeComMessage(input) {
    // 正式 POST 回调先验签再解密，不能直接信任 XML 里的 Encrypt 字段。
    // 这能防止非企业微信来源伪造消息进入客服回复队列。
    if (!input.encryptedXml) {
        throw new Error('企业微信加密 XML 不能为空');
    }
    const parsed = xmlParser.parse(input.encryptedXml);
    const encrypt = parsed.xml?.Encrypt;
    if (!encrypt) {
        throw new Error('没有从企业微信 XML 中解析到 Encrypt 字段');
    }
    const signature = sha1(input.token, input.timestamp ?? '', input.nonce ?? '', encrypt);
    if (signature !== input.msgSignature) {
        throw new Error(`企业微信消息签名校验失败：计算得到 ${signature}，传入 ${input.msgSignature}`);
    }
    return decryptText({
        encodingAESKey: input.encodingAESKey,
        encryptedText: encrypt,
        corpId: input.corpId
    });
}
export function parseWeComXml(xml) {
    // fast-xml-parser 会把 XML 转成普通对象，回调路由再按 MsgType/Event 分发。
    // 解析逻辑集中在这里，避免路由层散落 XML 处理细节。
    const parsed = xmlParser.parse(xml);
    return parsed.xml ?? {};
}
