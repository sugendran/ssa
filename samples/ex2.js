require('ssa').runSuite([
{
    test: 'google API returns results for paris hilton' ,
    getJSON: 'https://ajax.googleapis.com/ajax/services/search/web?v=1.0&q=Paris%20Hilton',
    expectCode: 200,
    expect:
    {
        "has 4 results" : function(data) { this.assert.equal(data.responseData.results.length, 4); },
        "is correct class" : function(data) { this.assert.equal(data.responseData.results[0].GsearchResultClass,  'GwebSearch'); }
    }
},
{
    test: 'google API returns results for george clooney' ,
    getJSON: 'https://ajax.googleapis.com/ajax/services/search/web?v=1.0&q=George%20Clooney',
    expectCode: 200,
    expect:
    {
        "has 4 results" : function(data) { this.assert.equal(data.responseData.results.length, 4); },
        "is correct class" : function(data) { this.assert.equal(data.responseData.results[0].GsearchResultClass,  'GwebSearch'); }
    }
}]);