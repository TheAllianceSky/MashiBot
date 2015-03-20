/**
 * This is the file where commands get parsed
 *
 * Some parts of this code are taken from the Pokémon Showdown server code, so
 * credits also go to Guangcong Luo and other Pokémon Showdown contributors.
 * https://github.com/Zarel/Pokemon-Showdown
 *
 * @license MIT license
 */

var sys = require('sys');
var https = require('https');
var url = require('url');

const ACTION_COOLDOWN = 3*1000;
const FLOOD_MESSAGE_NUM = 5;
const FLOOD_PER_MSG_MIN = 500; // this is the minimum time between messages for legitimate spam. It's used to determine what "flooding" is caused by lag
const FLOOD_MESSAGE_TIME = 6*1000;
const MIN_CAPS_LENGTH = 18;
const MIN_CAPS_PROPORTION = 0.8;

settings = {};
try {
	settings = JSON.parse(fs.readFileSync('settings.json'));
	if (!Object.keys(settings).length && settings !== {}) settings = {};
} catch (e) {} // file doesn't exist [yet]

messages = {};
try {
	messages = JSON.parse(fs.readFileSync('messages.json'));
	if (!Object.keys(messages).length && messages !== {}) messages = {};
} catch (e) {} // file doesn't exist [yet]

exports.parse = {
	actionUrl: url.parse('https://play.pokemonshowdown.com/~~' + config.serverid + '/action.php'),
	room: 'lobby',
	'settings': settings,
	'messages': messages,
	chatData: {},
	ranks: {},
	msgQueue: [],
	blacklistRegexes: {},

	data: function(data, connection) {
		if (data.substr(0, 1) === 'a') {
			data = JSON.parse(data.substr(1));
			if (data instanceof Array) {
				for (var i = 0, len = data.length; i < len; i++) {
					this.splitMessage(data[i], connection);
				}
			} else {
				this.splitMessage(data, connection);
			}
		}
	},
	splitMessage: function(message, connection) {
		if (!message) return;

		var room = 'lobby';
		if (message.indexOf('\n') < 0) return this.message(message, connection, room);
		
		var spl = message.split('\n');
		
		if (spl[0].charAt(0) === '>') {
			if (spl[1].substr(1, 4) === 'init') return ok('joined ' + spl[2].substr(7));
			if (spl[1].substr(1, 10) === 'tournament') return;
			room = spl.shift().substr(1);
		}

		for (var i = 0, len = spl.length; i < len; i++) {
			this.message(spl[i], connection, room);
		}
	},
	message: function(message, connection, room) {
		var spl = message.split('|');
		if (!spl[1]) {
			if (/was promoted to/i.test(spl[0])) this.say(connection, room, 'Congratulations on the promotion ' + spl[0].substr(0, spl[0].indexOf("was") - 1) + '!^-^');
			spl = spl[0].split('>');
			if (spl[1]) this.room = spl[1];
			return;
		}
		
		switch (spl[1]) {
			case 'challstr':
				info('received challstr, logging in...');
				var id = spl[2];
				var str = spl[3];

				var requestOptions = {
					hostname: this.actionUrl.hostname,
					port: this.actionUrl.port,
					path: this.actionUrl.pathname,
					agent: false
				};

				if (!config.pass) {
					requestOptions.method = 'GET';
					requestOptions.path += '?act=getassertion&userid=' + toId(config.nick) + '&challengekeyid=' + id + '&challenge=' + str;
				} else {
					requestOptions.method = 'POST';
					var data = 'act=login&name=' + config.nick + '&pass=' + config.pass + '&challengekeyid=' + id + '&challenge=' + str;
					requestOptions.headers = {
						'Content-Type': 'application/x-www-form-urlencoded',
						'Content-Length': data.length
					};
				}

				var req = https.request(requestOptions, function(res) {
					res.setEncoding('utf8');
					var data = '';
					res.on('data', function(chunk) {
						data += chunk;
					});
					res.on('end', function() {
						if (data === ';') {
							error('failed to log in; nick is registered - invalid or no password given');
							process.exit(-1);
						}
						if (data.length < 50) {
							error('failed to log in: ' + data);
							process.exit(-1);
						}

						if (data.indexOf('heavy load') !== -1) {
							error('the login server is under heavy load; trying again in one minute');
							setTimeout(function() {
								this.message(message);
							}.bind(this), 60 * 1000);
							return;
						}

						if (data.substr(0, 16) === '<!DOCTYPE html>') {
							error('Connection error 522; trying agian in one minute');
							setTimeout(function() {
								this.message(message);
							}.bind(this), 60 * 1000);
							return;
						}

						try {
							data = JSON.parse(data.substr(1));
							if (data.actionsuccess) {
								data = data.assertion;
							} else {
								error('could not log in; action was not successful: ' + JSON.stringify(data));
								process.exit(-1);
							}
						} catch (e) {}
						send(connection, '|/trn ' + config.nick + ',0,' + data);
					}.bind(this));
				}.bind(this));

				req.on('error', function(err) {
					error('login error: ' + sys.inspect(err));
				});

				if (data) req.write(data);
				req.end();
				break;
			case 'updateuser':
				if (spl[2] !== config.nick) return;

				if (spl[3] !== '1') {
					error('failed to log in, still guest');
					process.exit(-1);
				}

				ok('logged in as ' + spl[2]);

				// Now join the rooms
				this.msgQueue.push('|/blockchallenges');
				for (var i = 0, len = config.rooms.length; i < len; i++) {
					var room = toId(config.rooms[i]);
					if (room === 'lobby' && config.serverid === 'showdown') continue;
					this.msgQueue.push('|/join ' + room);
				}
				for (var i = 0, len = config.privaterooms.length; i < len; i++) {
					var room = toId(config.privaterooms[i]);
					if (room === 'lobby' && config.serverid === 'showdown') continue;
					this.msgQueue.push('|/join ' + room);
				}
				if (this.settings.blacklist) {
					var blacklist = this.settings.blacklist;
					for (var room in blacklist) {
						this.updateBlacklistRegex(room);
					}
				}
				this.msgDequeue = setInterval(function () {
					var msg = this.msgQueue.shift();
					if (msg) return send(connection, msg);
					clearInterval(this.msgDequeue);
					this.msgDequeue = null;
				}.bind(this), 750);
				setInterval(this.cleanChatData.bind(this), 30 * 60 * 1000);
				break;
			case 'c':
				var by = spl[2];
				spl = spl.slice(3).join('|');
				this.processChatData(toId(by), room, connection, spl);
				if (this.isBlacklisted(toId(by), room)) this.say(connection, room, '/roomban ' + by + ', Blacklisted user');
				this.chatMessage(spl, by, room, connection);
				if (toId(by) === toId(config.nick) && ' +%@&#~'.indexOf(by.charAt(0)) > -1) this.ranks[room] = by.charAt(0);
				break;
			case 'c:':
				var by = spl[3];
				spl = spl.slice(4).join('|');
				this.processChatData(toId(by), room, connection, spl);
				if (this.isBlacklisted(toId(by), room)) this.say(connection, room, '/roomban ' + by + ', Blacklisted user');
				this.chatMessage(spl, by, room, connection);
				if (toId(by) === toId(config.nick) && ' +%@&#~'.indexOf(by.charAt(0)) > -1) this.ranks[room] = by.charAt(0);
				break;
			case 'pm':
				var by = spl[2];
				spl = spl.slice(4).join('|');
				if (toId(by) === toId(config.nick) && ' +%@&#~'.indexOf(by.charAt(0)) > -1) this.ranks[room] = by.charAt(0);
				this.chatMessage(spl, by, ',' + by, connection);
				break;
			case 'N':
				var by = spl[2];
				this.updateSeen(spl[3], spl[1], toId(by));
				if (toId(by) === toId(config.nick) && ' +%@&#~'.indexOf(by.charAt(0)) > -1) this.ranks[room] = by.charAt(0);
				if (this.room && this.sendMail([toId(by)], this.room)) {
					for (var msgNumber in this.messages[toId(by)]) {
						if (msgNumber === 'timestamp') continue;
						this.say(connection, this.room, '/msg ' + by + ', ' + this.messages[toId(by)][msgNumber]);
					}
					delete this.messages[toId(by)];
					this.writeMessages();
				}
				break;
			case 'J': case 'j':
				var by = spl[2];
				if (config.serverid === 'showdown' && room === 'lobby') this.say(connection, room, '/part');
				if (this.isBlacklisted(toId(by), room)) this.say(connection, room, '/roomban ' + by + ', Blacklisted user');
				this.updateSeen(toId(by), spl[1], room);
				if (toId(by) === toId(config.nick) && ' +%@&#~'.indexOf(by.charAt(0)) > -1) this.ranks[room] = by.charAt(0);
				if (toId(by) == 'goddessbriyella') this.say(connection, room, 'Haaii Briyella!^-^ I missed you ;~;');
				if (toId(by) == 'themansavage') this.say(connection, room, 'Hey Butch :3');
				if (toId(by) == 'omegaxis14') this.say(connection, room, '**om**e**g**a o3o hai :3');
				if (this.room && this.sendMail([toId(by)], this.room)) {
					for (var msgNumber in this.messages[toId(by)]) {
						if (msgNumber === 'timestamp') continue;
						this.say(connection, this.room, '/msg ' + by + ', ' + this.messages[toId(by)][msgNumber]);
					}
					delete this.messages[toId(by)];
					this.writeMessages();
				}
				break;
			case 'l': case 'L':
				this.updateSeen(toId(spl[2]), spl[1], room);
				break;
			case 'raw':
				if (/[5-9] ?days/i.test(spl[2])) this.say(connection, room, 'zarel pls ;-;');
				break;
			case 'tournament':
				if (/\{"results"\:\[\[/i.test(spl[2])) this.say(connection, room, 'Good job ' + spl[2].substr(spl[2].indexOf("results") + 12, spl[2].indexOf("\"\],\[")) + ' on winning the tournament!^~^');
				break;
		}
	},
	chatMessage: function(message, by, room, connection) {
		var cmdrMessage = '["' + room + '|' + by + '|' + message + '"]';
		message = message.trim();
		// auto accept invitations to rooms
		if (room.charAt(0) === ',' && message.substr(0,8) === '/invite ' && this.hasRank(by, '%@&~') && !(config.serverid === 'showdown' && toId(message.substr(8)) === 'lobby')) {
			this.say(connection, '', '/join ' + message.substr(8));
		}
		if (message.substr(0, config.commandcharacter.length) !== config.commandcharacter || toId(by) === toId(config.nick)) return;

		message = message.substr(config.commandcharacter.length);
		var index = message.indexOf(' ');
		var arg = '';
		if (index > -1) {
			var cmd = message.substr(0, index);
			arg = message.substr(index + 1).trim();
		} else {
			var cmd = message;
		}

		if (Commands[cmd]) {
			var failsafe = 0;
			while (typeof Commands[cmd] !== "function" && failsafe++ < 10) {
				cmd = Commands[cmd];
			}
			if (typeof Commands[cmd] === "function") {
				cmdr(cmdrMessage);
				Commands[cmd].call(this, arg, by, room, connection);
			} else {
				error("invalid command type for " + cmd + ": " + (typeof Commands[cmd]));
			}
		}
	},
	say: function(connection, room, text) {
		if (room.charAt(0) !== ',') {
			var str = (room !== 'lobby' ? room : '') + '|' + text;
		} else {
			room = room.substr(1);
			var str = '|/pm ' + room + ', ' + text;
		}
		this.msgQueue.push(str);
		if (!this.msgDequeue) {
			this.msgDequeue = setInterval(function () {
				var msg = this.msgQueue.shift();
				if (msg) return send(connection, msg);
				clearInterval(this.msgDequeue);
				this.msgDequeue = null;
			}.bind(this), 750);
		}
	},
	hasRank: function(user, rank) {
		var hasRank = (rank.split('').indexOf(user.charAt(0)) !== -1) || (config.excepts.indexOf(toId(user)) !== -1);
		return hasRank;
	},
	canUse: function(cmd, room, user) {
		var canUse = false;
		var ranks = ' +%@&#~';
		if (!this.settings[cmd] || !this.settings[cmd][room]) {
			canUse = this.hasRank(user, ranks.substr(ranks.indexOf((cmd === 'autoban' || cmd === 'banword') ? '#' : config.defaultrank)));
		} else if (this.settings[cmd][room] === true) {
			canUse = true;
		} else if (ranks.indexOf(this.settings[cmd][room]) > -1) {
			canUse = this.hasRank(user, ranks.substr(ranks.indexOf(this.settings[cmd][room])));
		}
		return canUse;
	},
	isBlacklisted: function(user, room) {
		var blacklistRegexes = this.blacklistRegexes;
		return (blacklistRegexes && blacklistRegexes[room] && blacklistRegexes[room].test(user));
	},
	sendMail: function(user, room) {
		if (!this.messages || !this.messages[user]) return false;
		if (this.messages[user]) {
			console.log(user + ' has mail.');
			return true;
		}
	},
	blacklistUser: function(user, room) {
		var blacklist = this.settings.blacklist || (this.settings.blacklist = {});
		if (!blacklist[room]) blacklist[room] = {};

		if (blacklist[room][user]) return false;
		blacklist[room][user] = 1;
		this.updateBlacklistRegex(room);
		return true;
	},
	unblacklistUser: function(user, room) {
		var blacklist = this.settings.blacklist;
		if (!blacklist || !blacklist[room] || !blacklist[room][user]) return false;
		delete blacklist[room][user];
		this.updateBlacklistRegex(room);
		return true;
	},
	updateBlacklistRegex: function(room) {
		var blacklist = this.settings.blacklist[room];
		if (Object.isEmpty(blacklist)) {
			delete this.blacklistRegexes[room];
			return false;
		}
		var buffer = [];
		for (var entry in blacklist) {
			if (/^\/[^\/]+\/i$/.test(entry)) {
				buffer.push(entry.slice(1, -2));
			} else {
				buffer.push('^' + entry + '$');
			}
		}
		this.blacklistRegexes[room] = new RegExp(buffer.join('|'), 'i');
	},
	uploadToHastebin: function(toUpload, callback) {
		var reqOpts = {
			hostname: "hastebin.com",
			method: "POST",
			path: '/documents'
		};

		var req = require('http').request(reqOpts, function(res) {
			res.on('data', function(chunk) {
				if (callback && typeof callback === "function") callback("hastebin.com/raw/" + JSON.parse(chunk.toString())['key']);
			});
		});

		req.write(toUpload);
		req.end();
	},
	processChatData: function(user, room, connection, msg, by) {
		var botName = msg.toLowerCase().indexOf(toId(config.nick));
		
		if (toId(user.substr(1)) === toId(config.nick)) {
			this.ranks[room] = user.charAt(0);
			return;
		}
		var by = user;
		user = toId(user);
		var user = toId(by);
		
		if (!user || room.charAt(0) === ',') return;
		room = toId(room);
		msg = msg.trim().replace(/[ \u0000\u200B-\u200F]+/g, ' '); // removes extra spaces and null characters so messages that should trigger stretching do so
		
		this.updateSeen(user, 'c', room);
		var now = Date.now();
		if (!this.chatData[user]) this.chatData[user] = {zeroTol: 0, lastSeen: '', seenAt: now};
		
		var userData = this.chatData[user];
		if (!this.chatData[user][room]) this.chatData[user][room] = {times: [],	points: 0, lastAction: 0};
		
		var roomData = userData[room];
		roomData.times.push(now);
		this.chatData[user][room].times.push(now);
		
		if (config.resetduration) {
			clearTimeout(global.connectionTimer);
			refreshConnectionTimer();
		}
		
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////// Regex //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
		
		//Greetings & Farewells
		if (/(good)? ?(night|nite) (everyone|guys|tha|friends|all)/i.test(msg) && toId(config.nick) !== toId(by)) this.say(connection, room, 'Goodnight ' + by + '^-^');
		if (/i(\'?m| am).*go.*to (bed|sleep)/i.test(msg) && toId(config.nick) !== toId(by)) this.say(connection, room, 'Goodnight ' + by + '^-^');
		if (/(hey|hi|hello|ha+?i+) (everyone|guys|tha|friends|all)/i.test(msg) && toId(config.nick) !== toId(by)) this.say(connection, room, 'Haaii ' + by + '^-^');
		if (/(bye|g2g|ba+?i+) (everyone|guys|tha|friends|all)/i.test(msg) && toId(config.nick) !== toId(by)) this.say(connection, room, 'Baaii ' + by + '~');
		if (/g2g/i.test(msg) && toId(config.nick) !== toId(by)) this.say(connection, room, 'Baaii ' + by + '~');
		if (/how(\'re)? (r|are|is) (u|you|chu)? mash(i|y|iro)?bot??/i.test(msg)) this.say(connection, room, 'I am good, how are you ' + by + '? :o');
		
		//if (/(?:goddess ?)?mash(i|y|iro)(?:(?! *bot) ?chan)?/i.test(msg) && isAfk == true) this.say(connection, room, '/w ' + user + ', Mashiro-chan is AFK right now, leave a PM or check back in a bit, thanks^-^');
		
		//Miscellaneous
		if (/(why are there )?so many bots( in here)?\??/i.test(msg)) this.say(connection, room, 'Sorry if I\'m intruding, I\'ll try and be as quiet as possible! >~<');
		if (/(mashiro|mashy|goddess ?mashiro)/i.test(msg) && isAfk == true) this.say(connection, room, '/w ' + user + ', Mashiro-chan is AFK right now, leave a PM or check back in a bit, thanks^-^');
		if (/(why are there )?so many goddess(es)?( in here)?\??/i.test(msg)) this.say(connection, room, 'Mashiro is just a Briyella wannabe o3o');
		if (/9[0-9]% compatible/i.test(msg)) this.say(connection, room, '__it was meant to be :O__');
		if (/ [0-9]% compatible/i.test(msg)) this.say(connection, room, '__rip ;-;__');
		
		//Faveorite Pokemon
		if (/what(\'s| is)? (goddess ?)?mash(i|y|iro)?(chan|bot)?\'?s? fav(e|ou?rite)? poke(mon)?\??/i.test(msg)) this.say(connection, room, '!data Ninetales');
		if (/what(\'s| is)? (goddess ?)?bri(yella)?\'?s? fav(e|ou?rite)? poke(mon)?\??/i.test(msg)) this.say(connection, room, '!data Vespiquen');
		if (/what(\'s| is)? omega-?(xis14)?\'?s? fav(e|ou?rite)? poke(mon)?\??/i.test(msg)) this.say(connection, room, '!data Mew');
		if (/what(\'s| is)? (the|butch) ?mansavage\'?s? fav(e|ou?rite)? poke(mon)?\??/i.test(msg) || /what(\'s| is)? butch\'?s? fav(ou?rite)? poke(mon)?\??/i.test(msg)) this.say(connection, room, '!data Rhyperior');
		
		//League Names
		if (/(does)? ?(some|any)(one|1|body) play (league( of legends)?|lol)/i.test(msg)) this.say(connection, room, 'Add Mashiro-chan on League if you want to play: LeInfiniti');
		if (/what(\'s| is)? jess(ilina| league)?\'?s? (league( of legends)?|lol)( name)?/i.test(msg)) this.say(connection, room, 'Jess\'s League name is: namegohere');
		
		if (botName > -1 && toId(by) !== toId(config.nick)) {
			if (/^\/me/i.test(msg)) {
				if (/(pet|stroke)s?/i.test(msg)) {
					this.say(connection, room, '/me purrs~'); 
					return;
				}
				if (/licks?/i.test(msg)) {
					this.say(connection, room, '/me squirms ;~;'); 
					return;
				}
				if (/(eat|nom|nibble)s?/i.test(msg)) {
					this.say(connection, room, 'nuuu dun eat me ;~;'); 
					this.say(connection, room, '/me hides'); 
					return;
				}
				if (/(hit|stab|punch|kick|hurt)s?/i.test(msg)) {
					this.say(connection, room, '/me cries in pain ;-;'); 
					return;
				}
				if (/(hug|glomp|squeeze)s?/i.test(msg)) {
					this.say(connection, room, '/me squee~ :3'); 
					return;
				}
				if (/(cuddle|snuggle)s?/i.test(msg)) {
					this.say(connection, room, '/me cuddles ' + by + ' back warmly<3'); 
					return;
				}
				if (/(gives? food|a cookie)/i.test(msg)) {
					this.say(connection, room, '/me noms :3'); 
					return;
				}
				if (/(tickle)s?/i.test(msg)) {
					this.say(connection, room, '/me giggles and squirms');
					this.say(connection, room, 'Staaahhhpp!! ;~;');
					return;
				}
				if (/cr(y|i|ie)s? (in(to)?|on|against) mash(i|y|iro)?bot\'?s?/i.test(msg)) {
					this.say(connection, room, 'Don\'t worry, it will be okay^~^');
					this.say(connection, room, '/me hugs ' + by + ' gently');
				}
			}
		}

		// this deals with punishing rulebreakers, but note that the bot can't think, so it might make mistakes
		if (config.allowmute && this.hasRank(this.ranks[room] || ' ', '%@&#~') && config.whitelist.indexOf(user) === -1) {
			var useDefault = !(this.settings.modding && this.settings.modding[room]);
			var pointVal = 0;
			var muteMessage = '';
			var modSettings = useDefault ? null : this.settings.modding[room];

			// moderation for banned words
			if ((useDefault || !this.settings.banword[room]) && pointVal < 2) {
				var bannedPhraseSettings = this.settings.bannedphrases;
				var bannedPhrases = !!bannedPhraseSettings ? (Object.keys(bannedPhraseSettings[room] || {})).concat(Object.keys(bannedPhraseSettings.global || {})) : [];
				for (var i = 0; i < bannedPhrases.length; i++) {
					if (msg.toLowerCase().indexOf(bannedPhrases[i]) > -1) {
						pointVal = 2;
						muteMessage = ', Automated response: your message contained a banned phrase';
						break;
					}
				}
			}
			// moderation for flooding (more than x lines in y seconds)
			var times = roomData.times;
			var timesLen = times.length;
			var isFlooding = (timesLen >= FLOOD_MESSAGE_NUM && (now - times[timesLen - FLOOD_MESSAGE_NUM]) < FLOOD_MESSAGE_TIME
				&& (now - times[timesLen - FLOOD_MESSAGE_NUM]) > (FLOOD_PER_MSG_MIN * FLOOD_MESSAGE_NUM));
			if ((useDefault || !('flooding' in modSettings)) && isFlooding) {
				if (pointVal < 2) {
					pointVal = 2;
					muteMessage = ', Automated response: flooding';
				}
			}
			// moderation for caps (over x% of the letters in a line of y characters are capital)
			var capsMatch = msg.replace(/[^A-Za-z]/g, '').match(/[A-Z]/g);
			if ((useDefault || !('caps' in modSettings)) && capsMatch && toId(msg).length > MIN_CAPS_LENGTH && (capsMatch.length >= ~~(toId(msg).length * MIN_CAPS_PROPORTION))) {
				if (pointVal < 1) {
					pointVal = 1;
					muteMessage = ', Automated response: caps';
				}
			}
			// moderation for stretching (over x consecutive characters in the message are the same)
			var stretchMatch = /(.)\1{7,}/gi.test(msg) || /(..+)\1{4,}/gi.test(msg); // matches the same character (or group of characters) 8 (or 5) or more times in a row
			if ((useDefault || !('stretching' in modSettings)) && stretchMatch) {
				if (pointVal < 1) {
					pointVal = 1;
					muteMessage = ', Automated response: stretching';
				}
			}

			if (pointVal > 0 && now - roomData.lastAction >= ACTION_COOLDOWN) {
				var cmd = 'mute';
				// defaults to the next punishment in config.punishVals instead of repeating the same action (so a second warn-worthy
				// offence would result in a mute instead of a warn, and the third an hourmute, etc)
				if (roomData.points >= pointVal && pointVal < 4) {
					roomData.points++;
					cmd = config.punishvals[roomData.points] || cmd;
				} else { // if the action hasn't been done before (is worth more points) it will be the one picked
					cmd = config.punishvals[pointVal] || cmd;
					roomData.points = pointVal; // next action will be one level higher than this one (in most cases)
				}
				if (config.privaterooms.indexOf(room) > -1 && cmd === 'warn') cmd = 'mute'; // can't warn in private rooms
				// if the bot has % and not @, it will default to hourmuting as its highest level of punishment instead of roombanning
				if (roomData.points >= 4 && !this.hasRank(this.ranks[room] || ' ', '@&#~')) cmd = 'hourmute';
				if (userData.zeroTol > 4) { // if zero tolerance users break a rule they get an instant roomban or hourmute
					muteMessage = ', Automated response: zero tolerance user';
					cmd = this.hasRank(this.ranks[room] || ' ', '@&#~') ? 'roomban' : 'hourmute';
				}
				if (roomData.points > 1) userData.zeroTol++; // getting muted or higher increases your zero tolerance level (warns do not)
				roomData.lastAction = now;
				this.say(connection, room, '/' + cmd + ' ' + user + muteMessage);
			}
		}
	},
	cleanChatData: function() {
		var chatData = this.chatData;
		for (var user in chatData) {
			for (var room in chatData[user]) {
				var roomData = chatData[user][room];
				if (!Object.isObject(roomData)) continue;

				if (!roomData.times || !roomData.times.length) {
					delete chatData[user][room];
					continue;
				}
				var newTimes = [];
				var now = Date.now();
				var times = roomData.times;
				for (var i = 0, len = times.length; i < len; i++) {
					if (now - times[i] < 5 * 1000) newTimes.push(times[i]);
				}
				newTimes.sort(function (a, b) {
					return a - b;
				});
				roomData.times = newTimes;
				if (roomData.points > 0 && roomData.points < 4) roomData.points--;
			}
		}
	},

	updateSeen: function(user, type, detail) {
		if (type !== 'n' && config.rooms.indexOf(detail) === -1 || config.privaterooms.indexOf(toId(detail)) > -1) return;
		var now = Date.now();
		if (!this.chatData[user]) this.chatData[user] = {
			zeroTol: 0,
			lastSeen: '',
			seenAt: now
		};
		if (!detail) return;
		var userData = this.chatData[user];
		var msg = '';
		switch (type) {
		case 'j':
		case 'J':
			msg += 'joining ';
			break;
		case 'l':
		case 'L':
			msg += 'leaving ';
			break;
		case 'c':
		case 'c:':
			msg += 'chatting in ';
			break;
		case 'N':
			msg += 'changing nick to ';
			if (detail.charAt(0) !== ' ') detail = detail.substr(1);
			break;
		}
		msg += detail.trim() + '.';
		userData.lastSeen = msg;
		userData.seenAt = now;
	},
	getTimeAgo: function(time) {
		time = ~~((Date.now() - time) / 1000);

		var seconds = time % 60;
		var times = [];
		if (seconds) times.push(seconds + (seconds === 1 ? ' second': ' seconds'));
		if (time >= 60) {
			time = ~~((time - seconds) / 60);
			var minutes = time % 60;
			if (minutes) times.unshift(minutes + (minutes === 1 ? ' minute' : ' minutes'));
			if (time >= 60) {
				time = ~~((time - minutes) / 60);
				hours = time % 24;
				if (hours) times.unshift(hours + (hours === 1 ? ' hour' : ' hours'));
				if (time >= 24) {
					days = ~~((time - hours) / 24);
					if (days) times.unshift(days + (days === 1 ? ' day' : ' days'));
				}
			}
		}
		if (!times.length) return '0 seconds';
		return times.join(', ');
	},
	writeSettings: (function() {
		var writing = false;
		var writePending = false; // whether or not a new write is pending
		var finishWriting = function() {
			writing = false;
			if (writePending) {
				writePending = false;
				this.writeSettings();
			}
		};
		return function() {
			if (writing) {
				writePending = true;
				return;
			}
			writing = true;
			var data = JSON.stringify(this.settings);
			fs.writeFile('settings.json.0', data, function() {
				// rename is atomic on POSIX, but will throw an error on Windows
				fs.rename('settings.json.0', 'settings.json', function(err) {
					if (err) {
						// This should only happen on Windows.
						fs.writeFile('settings.json', data, finishWriting);
						return;
					}
					finishWriting();
				});
			});
		};
	})(),
	writeMessages: (function() {
		var writing = false;
		var writePending = false; // whether or not a new write is pending
		var finishWriting = function() {
			writing = false;
			if (writePending) {
				writePending = false;
				this.writeMessages();
			}
		};
		return function() {
			if (writing) {
				writePending = true;
				return;

			}
			writing = true;
			var data = JSON.stringify(this.messages);
			fs.writeFile('messages.json.0', data, function() {
				// rename is atomic on POSIX, but will throw an error on Windows
				fs.rename('messages.json.0', 'messages.json', function(err) {
					if (err) {
						// This should only happen on Windows.
						fs.writeFile('messages.json', data, finishWriting);
						return;
					}
					finishWriting();
				});
			});
		};
	})(),
	uncacheTree: function(root) {
		var uncache = [require.resolve(root)];
		do {
			var newuncache = [];
			for (var i = 0; i < uncache.length; ++i) {
				if (require.cache[uncache[i]]) {
					newuncache.push.apply(newuncache,
						require.cache[uncache[i]].children.map(function(module) {
							return module.filename;
						})
					);
					delete require.cache[uncache[i]];
				}
			}
			uncache = newuncache;
		} while (uncache.length > 0);
	},
	getDocMeta: function(id, callback) {
		https.get('https://www.googleapis.com/drive/v2/files/' + id + '?key=' + config.googleapikey, function (res) {
			var data = '';
			res.on('data', function (part) {
				data += part;
			});
			res.on('end', function (end) {
				var json = JSON.parse(data);
				if (json) {
					callback(null, json);
				} else {
					callback('Invalid response', data);
				}
			});
		});
	},
	getDocCsv: function(meta, callback) {
		https.get('https://docs.google.com/spreadsheet/pub?key=' + meta.id + '&output=csv', function (res) {
			var data = '';
			res.on('data', function (part) {
				data += part;
			});
			res.on('end', function (end) {
				callback(data);
			});
		});
	}
};