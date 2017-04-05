function Sdp() {
}

Sdp.prototype.parseSdp = function(s) {
    const lines = s.split(/[\r\n]+/);
    const sdp = {};
    let media;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.match(/^\s*$/)) {
            console.log('Skipping empty sdp line');
            continue;
        }
        const r = line.match(/^(.+?)=(.+)$/);
        if (!r) {
            console.error('Couldn\'t parse sdp line: ' + line);
            continue;
        }
        const key = r[1];
        const value = r[2];
        switch (key) {
            case 'v':
                sdp.version = value | 0;
                break;
            case 'o': {
                const r = value.match(/^(.*?) (.*?) (.*?) (.*?) IP(.*) (.*?)$/);
                if (r) {
                    sdp.origin = {
                        username: r[1],
                        sessionId: r[2],
                        sessionVersion: r[3] | 0,
                        netType: r[4],
                        ipVer: r[5] | 0,
                        address: r[6],
                    };
                } else {
                    console.error('Couldn\'t parse o= line: ' + line);
                }
                break;
            }
            case 's':
                sdp.name = value;
                break;
            case 't': {
                const r = value.match(/^(.*?) (.*?)$/);
                if (r) {
                    sdp.timing = {
                        start: r[1] | 0,
                        stop: r[2] | 0,
                    };
                } else {
                    console.error('Couldn\'t parse t= line: ' + line);
                }
                break;
            }
            case 'a': {
                const r = value.match(/^(.*?)(:(.*))?$/);
                if (r) {
                    const attr = r[1];
                    const args = r[3];
                    //console.log('a= line: r=' + JSON.stringify(r) + ' attr:' + attr + ' args:' + args);
                    switch (attr) {
                        case 'group': {
                            const r = args.match(/^(.*?) (.*)$/);
                            if (r) {
                                if (sdp.groups === undefined) sdp.groups = [];
                                sdp.groups.push({
                                    type: r[1],
                                    mids: r[2],
                                });
                            } else {
                                console.error('Couldn\'t parse group line: ' + line);
                            }
                            break;
                        }
                        case 'ice-options':
                            sdp.iceOptions = args;
                            break;
                        case 'msid-semantic': {
                            const r = args.match(/^ *(.*?) (.*)$/);
                            if (r) {
                                sdp.msidSemantic = {
                                    semantic: r[1],
                                    token: r[2],
                                };
                            } else {
                                console.error('Couldn\'t parse msid-semantic line: ' +
                                    line);
                            }
                            break;
                        }
                        case 'rtcp': {
                            const r = args.match(/^(.*?) (.*?) IP(.*?) (.*?)$/);
                            if (r) {
                                media.rtcp = {
                                    port: r[1] | 0,
                                    netType: r[2],
                                    ipVer: r[3] | 0,
                                    address: r[4],
                                };
                            } else {
                                console.error('Couldn\'t parse rtcp line: ' + line);
                            }
                            break;
                        }
                        case 'ice-ufrag':
                            media.iceUfrag = args;
                            break;
                        case 'ice-pwd':
                            media.icePwd = args;
                            break;
                        case 'fingerprint': {
                            const r = args.match(/^(.*?) (.*)$/);
                            if (r) {
                                const fingerprint = {
                                    type: r[1],
                                    hash: r[2],
                                };
                                if (media) {
                                    media.fingerprint = fingerprint;
                                } else {
                                    sdp.fingerprint = fingerprint;
                                }
                            } else {
                                console.error('Couldn\'t parse fingerprint line: ' +
                                    line);
                            }
                            break;
                        }
                        case 'setup':
                            media.setup = args;
                            break;
                        case 'mid':
                            media.mid = args;
                            break;
                        case 'msid':
                            media.msid = args;
                            break;
                        case 'extmap': {
                            const r = args.match(/^(.*?) (.*)$/);
                            if (r) {
                                if (media.ext === undefined) media.ext = [];
                                media.ext.push({
                                    value: r[1],
                                    uri: r[2],
                                });
                            } else {
                                console.error('Couldn\'t parse extmap line: ' + line);
                            }
                            break;
                        }
                        case 'sendrecv':
                        case 'sendonly':
                        case 'recvonly':
                        case 'inactive':
                            media.direction = attr;
                            break;
                        case 'rtcp-mux':
                            media.rtcpMux = attr;
                            break;
                        case 'rtcp-rsize':
                            media.rtcpRSize = attr;
                            break;
                        case 'rtpmap': {
                            const r = args.match(/^(.*?) (.*?)\/(.*?)(\/(.*?))?$/);
                            if (r) {
                                if (media.rtp === undefined) media.rtp = [];
                                const rtp = {
                                    payload: r[1] | 0,
                                    codec: r[2],
                                    rate: r[3] | 0,
                                };
                                if (r[5] !== undefined) rtp.encoding = r[5] | 0;
                                media.rtp.push(rtp);
                            } else {
                                console.error('Couldn\'t parse rtpmap line: ' + line);
                            }
                            break;
                        }
                        case 'fmtp': {
                            const r = args.match(/^(.*?) (.+?)$/);
                            if (r) {
                                if (media.fmtp === undefined) media.fmtp = [];
                                media.fmtp.push({
                                    payload: r[1] | 0,
                                    config: r[2],
                                });
                            } else {
                                console.error('Couldn\'t parse fmtp line: ' + line);
                            }
                            break;
                        }
                        case 'rtcp-fb': {
                            const r = args.match(/^(.*?) (.+?)$/);
                            if (r) {
                                if (media.rtcpFb === undefined) media.rtcpFb = [];
                                media.rtcpFb.push({
                                    payload: r[1] | 0,
                                    config: r[2],
                                });
                            } else {
                                console.error('Couldn\'t parse rtcp-fb line: ' + line);
                            }
                            break;
                        }
                        case 'maxptime':
                            media.maxptime = args;
                            break;
                        case 'ssrc-group':
                            media.ssrcGroup = args;
                            break;
                        case 'ssrc': {
                            const r = args.match(/^(.*?) (.*?):(.*)/);
                            if (r) {
                                if (media.ssrcs === undefined) media.ssrcs = [];
                                media.ssrcs.push({
                                    id: r[1],
                                    attribute: r[2],
                                    value: r[3],
                                });
                            } else {
                                console.error('Couldn\'t parse ssrc line: ' + line);
                            }
                            break;
                        }
                        case 'candidate': {
                            const r = args.match(
                                new RegExp([
                                    '^(.*?) (.*?) (.*?) (.*?) (.*?) (.*?) ',
                                    'typ (.*?) (.*? |)generation (.*)$',
                                ].join('')));

                            if (r) {
                                if (media.candidates === undefined) media.candidates = [];
                                const candidate = {
                                    foundation: parseInt(r[1]),
                                    component: r[2] | 0,
                                    transport: r[3],
                                    priority: parseInt(r[4]),
                                    ip: r[5],
                                    port: r[6] | 0,
                                    type: r[7],
                                    generation: r[9] | 0,
                                };
                                const r2 = r[8].match(/^raddr (.*?) rport (.*?) $/);
                                if (r2) {
                                    candidate.raddr = r2[1];
                                    candidate.rport = r2[2] | 0;
                                }
                                media.candidates.push(candidate);
                            } else {
                                console.error('Couldn\'t parse candidate line: ' + line);
                            }
                            break;
                        }
                    }
                } else {
                    console.error('Couldn\'t parse a= line: ' + line);
                }
                break;
            }
            case 'm': {
                const r = value.match(/^(.*?) (.*?) (.*?) (.*)$/);
                if (r) {
                    media = {
                        type: r[1],
                        port: r[2] | 0,
                        protocol: r[3],
                        payloads: r[4],
                    };
                    if (sdp.media === undefined) sdp.media = [];
                    sdp.media.push(media);
                } else {
                    console.error('Couldn\'t parse m= line: ' + line);
                }
                break;
            }
            case 'c': {
                const r = value.match(/^IN IP(.*?) (.*?)$/);
                if (r) {
                    media.connection = {
                        version: r[1] | 0,
                        ip: r[2],
                    };
                } else {
                    console.error('Couldn\'t parse c= line: ' + line);
                }
                break;
            }
        }
    }

    return sdp;
};

Sdp.prototype.compileSdp = function(sdp) {
    // compiles respoke 'parsed SDP' into real SDP for use
    // with WebRTC 1.0 (and thus Matrix)

    let s = '';
    if (sdp.version !== undefined) {
        s += 'v=' + sdp.version + '\r\n';
    }
    if (sdp.origin !== undefined) {
        s += 'o=' + sdp.origin.username + ' ' +
                     sdp.origin.sessionId + ' ' +
                    sdp.origin.sessionVersion + ' ' +
                    sdp.origin.netType + ' ' +
                    'IP' + sdp.origin.ipVer + ' ' +
                    sdp.origin.address + '\r\n';
    }
    if (sdp.name !== undefined) {
        s += 's=' + sdp.name + '\r\n';
    }
    if (sdp.timing !== undefined) {
        s += 't=' + sdp.timing.start + ' ' +
                    sdp.timing.stop + '\r\n';
    }
    if (sdp.fingerprint !== undefined) {
        s += 'a=fingerprint:' + sdp.fingerprint.type + ' ' +
            sdp.fingerprint.hash + '\r\n';
    }
    if (sdp.groups !== undefined) {
        for (let i = 0; i < sdp.groups.length; i++) {
            const group = sdp.groups[i];
            s += 'a=group:' + group.type + ' ' + group.mids + '\r\n';
        }
    }
    if (sdp.iceOptions !== undefined) {
        s += 'a=ice-options:' + sdp.iceOptions + '\r\n';
    }
    if (sdp.msidSemantic !== undefined) {
        s += 'a=msid-semantic:' + sdp.msidSemantic.semantic + ' ' +
                                   sdp.msidSemantic.token + '\r\n';
    }
    if (sdp.media !== undefined) {
        for (let i = 0; i < sdp.media.length; i++) {
            const media = sdp.media[i];
            s += 'm=' + media.type + ' ' +
                        media.port + ' ' +
                        media.protocol + ' ' +
                        media.rtp.map((rtp) => rtp.payload).join(' ') + '\r\n';
            if (media.connection !== undefined) {
                s += 'c=IN IP' + media.connection.version + ' ' +
                                 media.connection.ip + '\r\n';
            }
            if (media.rtcp !== undefined) {
                s += 'a=rtcp:' + media.rtcp.port + ' ' +
                                 media.rtcp.netType + ' ' +
                                 'IP' + media.rtcp.ipVer + ' ' +
                                 media.rtcp.address + '\r\n';
            }
            if (media.iceUfrag !== undefined) {
                s += 'a=ice-ufrag:' + media.iceUfrag + '\r\n';
            }
            if (media.icePwd !== undefined) {
                s += 'a=ice-pwd:' + media.icePwd + '\r\n';
            }
            if (media.fingerprint !== undefined) {
                s += 'a=fingerprint:' + media.fingerprint.type + ' '
                                      + media.fingerprint.hash + '\r\n';
            }
            if (media.setup !== undefined) {
                s += 'a=setup:' + media.setup + '\r\n';
            }
            if (media.mid !== undefined) {
                s += 'a=mid:' + media.mid + '\r\n';
            }
            if (media.msid !== undefined) {
                s += 'a=msid:' + media.msid + '\r\n';
            }
            if (media.ext !== undefined) {
                for (let j = 0; j < media.ext.length; j++) {
                    const ext = media.ext[j];
                    s += 'a=extmap:' + ext.value + ' ' +
                                        ext.uri + '\r\n';
                }
            }
            if (media.direction !== undefined) {
                s += 'a=' + media.direction + '\r\n';
            }
            if (media.rtcpMux !== undefined) {
                s += 'a=' + media.rtcpMux + '\r\n';
            }
            if (media.rtcpRSize !== undefined) {
                s += 'a=' + media.rtcpRSize + '\r\n';
            }
            if (media.rtp !== undefined) {
                for (let j = 0; j < media.rtp.length; j++) {
                    const rtp = media.rtp[j];
                    s += 'a=rtpmap:' + rtp.payload + ' ' +
                                       rtp.codec + '/' +
                                       rtp.rate;
                    if (rtp.encoding !== undefined) {
                        s += '/' + rtp.encoding;
                    }
                    s += '\r\n';

                    if (media.rtcpFb !== undefined) {
                        for (let k = 0; k < media.rtcpFb.length; k++) {
                            const rtcpFb = media.rtcpFb[k];
                            if (rtcpFb.payload === rtp.payload) {
                                s += 'a=rtcp-fb:' + rtcpFb.payload + ' ' +
                                                 rtcpFb.config + '\r\n';
                            }
                        }
                    }

                    if (media.fmtp !== undefined) {
                        for (let k = 0; k < media.fmtp.length; k++) {
                            const fmtp = media.fmtp[k];
                            if (fmtp.payload === rtp.payload) {
                                // XXX: respoke.io looks to get the parsing wrong
                                // and drops additional semi-colon separated fmtp params like
                                // useinbandfec=1
                                s += 'a=fmtp:' + fmtp.payload + ' ' +
                                                 fmtp.config + '\r\n';
                            }
                        }
                    }
                }
            }
            if (media.maxptime !== undefined) {
                s += 'a=maxptime:' + media.maxptime + '\r\n';
            }
            if (media.ssrcGroup !== undefined) {
                s += 'a=ssrc-group:' + media.ssrcGroup + '\r\n';
            }
            if (media.ssrcs !== undefined ) {
                for (let j = 0; j < media.ssrcs.length; j++) {
                    const ssrc = media.ssrcs[j];
                    s += 'a=ssrc:' + ssrc.id + ' ' +
                                      ssrc.attribute + ':' + ssrc.value + '\r\n';
                }
            }
            if (media.candidates !== undefined ) {
                for (let j = 0; j < media.candidates.length; j++) {
                    const candidate = media.candidates[j];
                    s += 'a=candidate:' + candidate.foundation + ' ' +
                                          candidate.component + ' ' +
                                          candidate.transport + ' ' +
                                          candidate.priority + ' ' +
                                          candidate.ip + ' ' +
                                          candidate.port + ' ' +
                                          'typ ' + candidate.type + ' ';

                    if (candidate.transport === 'tcp') {
                        s += 'tcptype active ';
                    }
                    if (candidate.raddr != undefined) {
                        s += 'raddr ' + candidate.raddr + ' ';
                    }
                    if (candidate.rport != undefined) {
                        s += 'rport ' + candidate.rport + ' ';
                    }
                    // XXX: respoke loses the generation param for TCP canditates
                    s += 'generation ' +
                        (candidate.generation ? candidate.generation : 0);
                    s += '\r\n';
                }
            }
        }
    }
    return s;
};

module.exports = Sdp;
