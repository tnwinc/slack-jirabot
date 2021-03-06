'use strict';

const JiraApi = require('jira-client');
const Botkit = require('botkit');
const moment = require('moment');
const J2S = require('jira2slack');
const logger = require('./logger')();
const PACKAGE = require('../package');

const RESPONSE_FULL = 'full';

/**
 * @module Bot
 */
class Bot {
  /**
   * Constructor.
   *
   * @constructor
   * @param {Config} config The final configuration for the bot
   */
  constructor (config) {
    this.config = config;
    /* hold tickets and last time responded to */
    this.ticketBuffer = new Map();

    /* Length of buffer to prevent ticket from being responded to */
    this.TICKET_BUFFER_LENGTH = 300000;

    this.controller = Botkit.slackbot({
      stats_optout: true,
      logger
    });

    this.ticketRegExp = new RegExp(config.jira.regex, 'g');
    logger.info(`Ticket Matching Regexp: ${this.ticketRegExp}`);

    this.jira = new JiraApi({
      protocol: config.jira.protocol,
      host: config.jira.host,
      port: config.jira.port,
      username: config.jira.user,
      password: config.jira.pass,
      apiVersion: config.jira.apiVersion,
      strictSSL: config.jira.strictSSL,
      base: config.jira.base
    });
  }

  /**
   * Build a response string about an issue.
   *
   * @param {Issue}  issue     the issue object returned by JIRA
   * @param {string} format the format to respond with
   * @return {Attachment} The response attachment.
   */
  issueResponse (issue, format) {
    const response = {
      fallback: `No summary found for ${issue.key}`,
      respondInThread: false
    };

    const fieldFormatters = {
      'Created': () => { return { value: moment(issue.fields.created).calendar(), short: true } },
      'Updated': () => { return { value: moment(issue.fields.updated).calendar(), short: true } },
      'Status': () => { return { value: issue.fields.status.name, short: true } },
      'Priority': () => { return { value: issue.fields.priority.name, short: true } },
      'Reporter': () => { return { value: (this.jira2Slack(issue.fields.reporter.name) || issue.fields.reporter.displayName), short: true } },
      'Assignee': () => {
        let assignee = 'Unassigned';
        if (issue.fields.assignee) {
          assignee = (this.jira2Slack(issue.fields.assignee.name) || issue.fields.assignee.displayName);
        }
        return { value: assignee, short: true };
      },
      'Sprint': () => {
        if (this.config.jira.sprintField) {
          return { value: (this.parseSprint(issue.fields[this.config.jira.sprintField]) || 'Not Assigned'), short: false };
        }
      }
    }
    
    const responseFormat = this.config.responseFormats[format];
    if (responseFormat.description) {
      response.text = this.formatIssueDescription(issue.fields.description);
    }
    if(responseFormat.respondInThread){
      response.respondInThread = true
    }

    response.mrkdwn_in = ['text']; // Parse text as markdown
    response.fallback = issue.fields.summary;
    if (responseFormat.pretext) {
      response.pretext = eval(responseFormat.pretext);
    }
    if (responseFormat.title) {
      response.title = eval(responseFormat.title)
    } else {
      response.title = issue.fields.summary;    
    }
    response.title_link = this.buildIssueLink(issue.key);
    if (!responseFormat.hideFooter) {
      response.footer = `Slack Jira ${PACKAGE.version} - ${PACKAGE.homepage}`;
    }
    response.fields = [];

    if (responseFormat.fields) {
      for (const field of responseFormat.fields) {
        let jiraField = null;
        if (fieldFormatters.hasOwnProperty(field)) {
          jiraField = fieldFormatters[field]();
          jiraField['title'] = field;
        } else {
          // Custom fields
          if (this.config.jira.customFields && Object.keys(this.config.jira.customFields).length) {
            Object.keys(this.config.jira.customFields).map((customField) => {
              jiraField = { title: field, value: issue.fields[customField], short: false };
            });
          }
        }
        response.fields.push(jiraField);
      }
    }

    return response;
  }

  /**
   * Format a ticket description for display.
   * * Truncate to 1000 characters
   * * Replace any {quote} with ```
   * * If there is no description, add a default value
   *
   * @param {string} description The raw description
   * @return {string} the formatted description
   */
  formatIssueDescription (description) {
    const desc = description || 'Ticket does not contain a description';
    return J2S.toSlack(desc);
  }

  /**
   * Construct a link to an issue based on the issueKey and config
   *
   * @param {string} issueKey The issueKey for the issue
   * @return {string} The constructed link
   */
  buildIssueLink (issueKey) {
    let base = '/browse/';
    if (this.config.jira.base) {
      // Strip preceeding and trailing forward slash
      base = `/${this.config.jira.base.replace(/^\/|\/$/g, '')}${base}`;
    }
    return `${this.config.jira.protocol}://${this.config.jira.host}:${this.config.jira.port}${base}${issueKey}`;
  }

  /**
   * Parses the sprint name of a ticket.
   * If the ticket is in more than one sprint
   * A. Shame on you
   * B. This will take the last one
   *
   * @param {string[]} customField The contents of the greenhopper custom field
   * @return {string} The name of the sprint or ''
   */
  parseSprint (customField) {
    let retVal = '';
    if (customField && customField.length > 0) {
      const sprintString = customField.pop();
      const matches = sprintString.match(/,name=([^,]+),/);
      if (matches && matches[1]) {
        retVal = matches[1];
      }
    }
    return retVal;
  }

  /**
   * Lookup a JIRA username and return their Slack username
   * Meh... Trying to come up with a better system for this feature
   *
   * @param {string} username the JIRA username
   * @return {string} The slack username or ''
   */
  jira2Slack (username) {
    let retVal = '';
    if (this.config.usermap[username]) {
      retVal = `@${this.config.usermap[username]}`;
    }
    return retVal;
  }

  /**
   * Parse out JIRA tickets from a message.
   * This will return unique tickets that haven't been
   * responded with recently.
   *
   * @param {string} channel the channel the message came from
   * @param {string} message the message to search in
   * @return {string[]} an array of tickets, empty if none found
   */
  parseTickets (channel, message) {
    const retVal = [];
    if (!channel || !message) {
      return retVal;
    }
    const uniques = {};
    const found = message.match(this.ticketRegExp);
    const now = Date.now();
    let ticketHash;
    if (found && found.length) {
      found.forEach((ticket) => {
        ticketHash = this.hashTicket(channel, ticket);
        if (
          !uniques.hasOwnProperty(ticket) &&
          (now - (this.ticketBuffer.get(ticketHash) || 0) > this.TICKET_BUFFER_LENGTH)
        ) {
          retVal.push(ticket);
          uniques[ticket] = 1;
          this.ticketBuffer.set(ticketHash, now);
        }
      });
    }
    return retVal;
  }

  /**
   * Hashes the channel + ticket combo.
   *
   * @param {string} channel The name of the channel
   * @param {string} ticket  The name of the ticket
   * @return {string} The unique hash
   */
  hashTicket (channel, ticket) {
    return `${channel}-${ticket}`;
  }

  /**
   * Remove any tickets from the buffer if they are past the length
   *
   * @return {null} nada
   */
  cleanupTicketBuffer () {
    const now = Date.now();
    logger.debug('Cleaning Ticket Buffer');
    this.ticketBuffer.forEach((time, key) => {
      if (now - time > this.TICKET_BUFFER_LENGTH) {
        logger.debug(`Deleting ${key}`);
        this.ticketBuffer.delete(key);
      }
    });
  }

  /**
   * Function to be called on slack open
   *
   * @param {object} payload Connection payload
   * @return {Bot} returns itself
   */
  slackOpen (payload) {
    const channels = [];
    const groups = [];
    const mpims = [];

    logger.info(`Welcome to Slack. You are @${payload.self.name} of ${payload.team.name}`);

    if (payload.channels) {
      payload.channels.forEach((channel) => {
        if (channel.is_member) {
          channels.push(`#${channel.name}`);
        }
      });

      logger.info(`You are in: ${channels.join(', ')}`);
    }

    if (payload.groups) {
      payload.groups.forEach((group) => {
        groups.push(`${group.name}`);
      });

      logger.info(`Groups: ${groups.join(', ')}`);
    }

    if (payload.mpims) {
      payload.mpims.forEach((mpim) => {
        mpims.push(`${mpim.name}`);
      });

      logger.info(`Multi-person IMs: ${mpims.join(', ')}`);
    }

    return this;
  }

  /**
   * Handle an incoming message
   * @param {object} message The incoming message from Slack
   * @returns {null} nada
   */
  handleMessage (message) {
    const slackResponse = {
      as_user: true,
      attachments: []
    };

    if (message.type === 'ambient' && message.text) {
      const found = this.parseTickets(message.channel, message.text);
      if (found && found.length) {
        logger.info(`Detected ${found.join(',')}`);
        found.forEach((issueId) => {
          this.jira.findIssue(issueId)
            .then((issue) => {
              // If direct mention, use full format
              const responseFormat = message.event === 'direct_mention' 
                ? this.config.jira.atResponseFormat 
                : this.config.channelFormats && this.config.channelFormats[message.channel]
                  ? this.config.channelFormats[message.channel]
                  : this.config.jira.responseFormat;
              logger.info(`channel: ${message.channel}, format: ${responseFormat}`)
              let response = this.issueResponse(issue, responseFormat);
              slackResponse.attachments = [response];
              if(response.respondInThread){
                this.bot.replyInThread(message, slackResponse, (err) => {
                  if (err) {
                    logger.error('Unable to respond', err);
                  } else {
                    logger.info(`@${this.bot.identity.name} responded with`, slackResponse);
                  }
                });                
              } else{
                this.bot.reply(message, slackResponse, (err) => {
                  if (err) {
                    logger.error('Unable to respond', err);
                  } else {
                    logger.info(`@${this.bot.identity.name} responded with`, slackResponse);
                  }
                });
              }
            })
            .catch((error) => {
              logger.error(`Got an error trying to find ${issueId}`, error);
            });
        });
      } else {
        // nothing to do
      }
    } else {
      logger.info(`@${this.bot.identity.name} could not respond. ${message.type} | ${message.text}`);
    }
  }

  /**
   * Start the bot
   *
   * @return {Bot} returns itself
   */
  start () {
    this.controller.on(
      'direct_mention,mention,ambient,direct_message',
      (bot, message) => {
        this.handleMessage(message);
      }
    );

    this.controller.on('rtm_close', () => {
      logger.info('The RTM api just closed');

      if (this.config.slack.autoReconnect) {
        this.connect();
      }
    });

    this.connect();

    setInterval(() => {
      this.cleanupTicketBuffer();
    }, 60000);

    return this;
  }

  /**
   * Connect to the RTM
   * @return {Bot} this
   */
  connect () {
    this.bot = this.controller.spawn({
      token: this.config.slack.token,
      retry: this.config.slack.autoReconnect ? Infinity : 0
    }).startRTM((err, bot, payload) => {
      if (err) {
        logger.error('Error starting bot!', err);
      }

      this.slackOpen(payload);
    });

    return this;
  }
}

module.exports = Bot;
