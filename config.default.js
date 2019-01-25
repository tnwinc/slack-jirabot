'use strict';

const config = {
  jira: {
    protocol: 'https',
    host: 'jira.yourhost.domain',
    port: 443,
    base: '',
    user: 'username',
    pass: 'password',
    apiVersion: 'latest',
    strictSSL: false,
    regex: '([A-Z][A-Z0-9]+-[0-9]+)',
    sprintField: '',
    customFields: {

    },
    atResponseFormat: 'full',	
    responseFormat: 'micro'
  },
  slack: {
    token: 'xoxb-Your-Token',
    autoReconnect: true
  },
  usermap: {},
  channelFormats: {},
  responseFormats: {
    micro: {
	  title: '`${issue.key}: ${issue.fields.summary}`',
      description: false,
      hideFooter: true,
      respondInThread: true
    },
    minimal: {
      description: true,
      pretext: '`Here is some information on ${issue.key}`'
    },
    full: {
      description: true,
      pretext: '`Here is some information on ${issue.key}`',
      fields: [
        'Created',
        'Updated',
        'Status',
        'Priority',
        'Reporter',
        'Assignee',
        'Sprint'
      ]
    }
  }  
};
module.exports = config;
